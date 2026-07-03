#include "hybrid_retriever.h"
#include <sstream>
#include <set>
#include <queue>
#include <unordered_set>

// ==========================================
// NODE.JS BINDING INITIALIZATION
// ==========================================
Napi::Object HybridRetriever::Init(Napi::Env env, Napi::Object exports)
{
    Napi::Function func = DefineClass(env, "HybridRetriever", {
        InstanceMethod("addDocument",              &HybridRetriever::AddDocument),
        InstanceMethod("addDocumentWithEmbedding", &HybridRetriever::AddDocumentWithEmbedding),
        InstanceMethod("hybridSearch",             &HybridRetriever::HybridSearch),
        InstanceMethod("sparseSearch",             &HybridRetriever::SparseSearch),
        InstanceMethod("removeDocument",           &HybridRetriever::RemoveDocument),
        InstanceMethod("getStats",                 &HybridRetriever::GetStats),
    });

    exports.Set("HybridRetriever", func);
    return exports;
}

// ==========================================
// CONSTRUCTOR
// ==========================================
HybridRetriever::HybridRetriever(const Napi::CallbackInfo &info)
    : Napi::ObjectWrap<HybridRetriever>(info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 2)
    {
        Napi::TypeError::New(env, "Expected (SemanticCache, options)")
            .ThrowAsJavaScriptException();
        return;
    }

    Napi::Object cacheObj = info[0].As<Napi::Object>();
    hnswIndex_ = Napi::ObjectWrap<SemanticCache>::Unwrap(cacheObj);

    dim_         = 384;
    denseWeight_ = 0.7f;

    if (info.Length() >= 2 && info[1].IsObject())
    {
        Napi::Object options = info[1].As<Napi::Object>();
        if (options.Has("dimension"))
            dim_ = options.Get("dimension").As<Napi::Number>().Uint32Value();
        if (options.Has("denseWeight"))
            denseWeight_ = options.Get("denseWeight").As<Napi::Number>().FloatValue();
    }

    totalDocs_   = 0;
    totalDocLen_ = 0;
    avgDocLen_   = 0.0;
}

HybridRetriever::~HybridRetriever()
{
    // hnswIndex_ is owned by Node.js — do not delete
}

// ==========================================
// TOKENIZATION
// ==========================================
std::vector<std::string> HybridRetriever::Tokenize(const std::string &text)
{
    std::vector<std::string> tokens;
    std::string current;
    current.reserve(32);

    for (char c : text)
    {
        if (std::isalnum((unsigned char)c) || c == '_' || c == '-')
        {
            current += (char)std::tolower((unsigned char)c);
        }
        else
        {
            if (current.length() > 1)
                tokens.push_back(current);
            current.clear();
        }
    }

    if (current.length() > 1)
        tokens.push_back(current);

    return tokens;
}

// ==========================================
// IDF COMPUTATION (cached)
// ==========================================
double HybridRetriever::ComputeIDF(const std::string &term)
{
    auto it = idfCache_.find(term);
    if (it != idfCache_.end())
        return it->second;

    if (totalDocs_ == 0)
        return 0.0;

    size_t docCount = 0;
    for (const auto &doc : documents_)
    {
        if (doc.termFreq.find(term) != doc.termFreq.end())
            docCount++;
    }

    double idf = std::log(
        (totalDocs_ - docCount + 0.5) / (docCount + 0.5) + 1.0
    );

    idfCache_[term] = idf;
    return idf;
}

// ==========================================
// BM25 SCORING
// ==========================================
double HybridRetriever::BM25Score(const BM25Doc &doc,
                                   const std::vector<std::string> &queryTokens)
{
    double score = 0.0;
    const double k1 = 1.2;
    const double b  = 0.75;

    if (avgDocLen_ == 0.0) return 0.0;

    for (const auto &term : queryTokens)
    {
        auto tfIt = doc.termFreq.find(term);
        if (tfIt == doc.termFreq.end())
            continue;

        double tf         = tfIt->second;
        double idf        = ComputeIDF(term);
        double docLenNorm = 1.0 - b + b * (doc.docLength / avgDocLen_);

        score += idf * ((tf * (k1 + 1.0)) / (tf + k1 * docLenNorm));
    }

    return score;
}

// ==========================================
// HR-9: CosineSimilarity removed — was defined but never called.
// HNSW distance (1.0f - top.first) is used for dense similarity.
// ==========================================

// ==========================================
// L2 NORMALIZATION
// ==========================================
std::vector<float> HybridRetriever::L2Normalize(const float *vec, int dim)
{
    std::vector<float> normalized(dim);
    double norm = 0.0;

    for (int i = 0; i < dim; i++)
        norm += vec[i] * vec[i];

    norm = std::sqrt(norm);

    if (norm > 0.0)
        for (int i = 0; i < dim; i++)
            normalized[i] = vec[i] / (float)norm;
    else
        // Zero vector — return as-is (no meaningful normalization)
        for (int i = 0; i < dim; i++)
            normalized[i] = vec[i];

    return normalized;
}

// ==========================================
// BREADCRUMB GENERATION
// ==========================================
std::string HybridRetriever::GenerateBreadcrumb(const std::string &text)
{
    size_t sentenceEnd = 0;

    for (size_t i = 0; i < text.length() && i < 500; i++)
    {
        if ((text[i] == '.' || text[i] == '!' || text[i] == '?') && i > 10)
        {
            sentenceEnd = i + 1;
            break;
        }
    }

    if (sentenceEnd > 0)
        return text.substr(0, std::min(sentenceEnd, (size_t)150));

    return text.substr(0, std::min(text.length(), (size_t)150));
}

// ==========================================
// HR-5: Inverted index maintenance
//
// Replaces O(n×terms) pre-filter in SparseSearch with O(terms) lookup.
// Updated on every add/remove.
// ==========================================
void HybridRetriever::addToInvertedIndex(size_t docIdx, const BM25Doc &doc)
{
    for (const auto &[term, _] : doc.termFreq)
        invertedIndex_[term].push_back(docIdx);
}

void HybridRetriever::removeFromInvertedIndex(size_t docIdx, const BM25Doc &doc)
{
    for (const auto &[term, _] : doc.termFreq)
    {
        auto it = invertedIndex_.find(term);
        if (it == invertedIndex_.end()) continue;

        auto &vec = it->second;
        vec.erase(std::remove(vec.begin(), vec.end(), docIdx), vec.end());

        if (vec.empty())
            invertedIndex_.erase(it);
    }
}

void HybridRetriever::rebuildInvertedIndex()
{
    invertedIndex_.clear();
    for (size_t i = 0; i < documents_.size(); i++)
        addToInvertedIndex(i, documents_[i]);
}

// ==========================================
// INTERNAL: shared BM25 indexing
//
// HR-1: Replaced O(n) erase-from-middle with O(1) swap-with-last.
//       The old approach shifted every element and decremented all
//       docIndex_ entries — O(n²) for repeated updates.
//
// HR-2: IDF cache now only clears entries for terms in the modified
//       document instead of clearing the entire cache. Terms not
//       affected by the change keep their cached IDF values.
// ==========================================
// HY-1: shared HNSW removal — marks the old vector deleted so dense search
// stops returning it. hnswlib's markDelete keeps the point out of results
// while reusing its slot memory lazily; meta/id maps are cleaned eagerly.
void HybridRetriever::removeFromHnsw(const std::string &id)
{
    if (!hnswIndex_ || !hnswIndex_->alg_hnsw_)
        return;

    auto labelIt = hnswIndex_->id_to_label_.find(id);
    if (labelIt == hnswIndex_->id_to_label_.end())
        return;

    size_t label = labelIt->second;
    try
    {
        hnswIndex_->alg_hnsw_->markDelete(label);
    }
    catch (const std::exception &e)
    {
        // Already deleted or label unknown — maps are cleaned below anyway
        fprintf(stderr,
            "[HybridRetriever] HNSW markDelete(%zu) for %s: %s\n",
            label, id.c_str(), e.what());
    }

    hnswIndex_->meta_map_.erase(label);
    hnswIndex_->id_to_label_.erase(labelIt);
    if (hnswIndex_->active_count_ > 0)
        hnswIndex_->active_count_--;
}

void HybridRetriever::addDocumentInternal(const std::string &id,
                                           const std::string &text)
{
    // ── Remove existing document if present ──────────────────────────────
    auto existingIt = docIndex_.find(id);
    if (existingIt != docIndex_.end())
    {
        size_t idx = existingIt->second;
        const BM25Doc &oldDoc = documents_[idx];

        totalDocLen_ -= oldDoc.docLength;

        // HR-2: Invalidate only IDF entries for terms in the removed document
        for (const auto &[term, _] : oldDoc.termFreq)
            idfCache_.erase(term);

        // HR-5: Remove from inverted index before moving
        removeFromInvertedIndex(idx, oldDoc);

        // HR-1: O(1) swap-with-last instead of O(n) erase-from-middle
        size_t lastIdx = documents_.size() - 1;
        if (idx != lastIdx)
        {
            // Move last document into the vacated slot
            documents_[idx] = std::move(documents_[lastIdx]);
            // Update the moved document's index entry
            docIndex_[documents_[idx].id] = idx;
            // Update inverted index: entries pointing to lastIdx now point to idx
            for (const auto &[term, _] : documents_[idx].termFreq)
            {
                auto iit = invertedIndex_.find(term);
                if (iit != invertedIndex_.end())
                {
                    for (auto &entry : iit->second)
                        if (entry == lastIdx) { entry = idx; break; }
                }
            }
        }
        documents_.pop_back();
        docIndex_.erase(id);
        totalDocs_--;
    }

    // ── Build new document ───────────────────────────────────────────────
    std::vector<std::string> tokens = Tokenize(text);

    std::unordered_map<std::string, int> termFreq;
    for (const auto &token : tokens)
        termFreq[token]++;

    BM25Doc doc;
    doc.id         = id;
    doc.text       = text;
    doc.tokens     = tokens;
    doc.termFreq   = termFreq;
    doc.docLength  = (int)tokens.size();
    doc.breadcrumb = GenerateBreadcrumb(text);

    size_t newIdx = documents_.size();
    documents_.push_back(std::move(doc));
    docIndex_[id] = newIdx;
    totalDocs_++;
    totalDocLen_ += documents_[newIdx].docLength;
    avgDocLen_    = (double)totalDocLen_ / totalDocs_;

    // HR-5: Add to inverted index
    addToInvertedIndex(newIdx, documents_[newIdx]);

    // HR-2: Invalidate IDF only for terms in the new document
    for (const auto &[term, _] : documents_[newIdx].termFreq)
        idfCache_.erase(term);
}

// ==========================================
// NODE.JS: ADD DOCUMENT
// ==========================================
Napi::Value HybridRetriever::AddDocument(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString())
    {
        Napi::TypeError::New(env, "Expected (id: string, text: string)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string id   = info[0].As<Napi::String>().Utf8Value();
    std::string text = info[1].As<Napi::String>().Utf8Value();

    addDocumentInternal(id, text);

    auto docIt = docIndex_.find(id);

    Napi::Object result = Napi::Object::New(env);
    result.Set("id", Napi::String::New(env, id));
    result.Set("breadcrumb", Napi::String::New(env,
        docIt != docIndex_.end() ? documents_[docIt->second].breadcrumb : ""));
    result.Set("tokens", Napi::Number::New(env,
        docIt != docIndex_.end() ? documents_[docIt->second].docLength : 0));
    return result;
}

// ==========================================
// NODE.JS: ADD DOCUMENT WITH EMBEDDING
// ==========================================
Napi::Value HybridRetriever::AddDocumentWithEmbedding(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 3 ||
        !info[0].IsString() ||
        !info[1].IsString() ||
        !info[2].IsTypedArray())
    {
        Napi::TypeError::New(env,
            "Expected (id: string, text: string, embedding: Float32Array)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string id   = info[0].As<Napi::String>().Utf8Value();
    std::string text = info[1].As<Napi::String>().Utf8Value();
    Napi::Float32Array embArr = info[2].As<Napi::Float32Array>();

    if (embArr.ElementLength() != (size_t)dim_)
    {
        std::string msg =
            "Embedding dimension mismatch: got " +
            std::to_string(embArr.ElementLength()) +
            ", expected " + std::to_string(dim_);
        Napi::TypeError::New(env, msg).ThrowAsJavaScriptException();
        return env.Null();
    }

    addDocumentInternal(id, text);

    // HY-2: re-adding an existing id must replace its vector, not add a
    // duplicate. Previously each re-index cycle added a NEW HNSW point for
    // the same id while the old one stayed searchable — meta_map_ still
    // resolved it, so dense search could return the same id twice with two
    // different (one stale) similarity scores, and the index leaked one
    // point per document per reindex.
    removeFromHnsw(id);

    if (hnswIndex_ && hnswIndex_->alg_hnsw_)
    {
        auto normalized = L2Normalize(embArr.Data(), dim_);
        try
        {
            size_t label = hnswIndex_->current_label_;
            hnswIndex_->alg_hnsw_->addPoint(normalized.data(), label);

            VectorMetadata meta;
            meta.id            = id;
            meta.namespaceName = "";
            meta.type          = "document";
            meta.payload       = "";
            hnswIndex_->meta_map_[label]  = meta;
            hnswIndex_->id_to_label_[id]  = label;
            hnswIndex_->current_label_++;
            hnswIndex_->active_count_++;
        }
        catch (const std::exception &e)
        {
            fprintf(stderr,
                "[HybridRetriever] HNSW insert failed for %s: %s\n",
                id.c_str(), e.what());
        }
    }

    auto docIt = docIndex_.find(id);

    Napi::Object result = Napi::Object::New(env);
    result.Set("id",      Napi::String::New(env, id));
    result.Set("breadcrumb", Napi::String::New(env,
        docIt != docIndex_.end() ? documents_[docIt->second].breadcrumb : ""));
    result.Set("indexed", Napi::Boolean::New(env, true));
    return result;
}

// ==========================================
// NODE.JS: HYBRID SEARCH
//
// HR-3: Query vector is now L2-normalized before HNSW search.
//       Stored vectors are normalized at insert time (AddDocumentWithEmbedding).
//       For IP-space HNSW, both query and stored vectors must be normalized
//       for the distance to equal 1 - cosine_similarity.
//
// HR-8: Dense-only path now returns "combinedScore" to match hybrid path.
// ==========================================
Napi::Value HybridRetriever::HybridSearch(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsTypedArray() || !info[1].IsNumber())
    {
        Napi::TypeError::New(env,
            "Expected (queryEmbedding: Float32Array, k: number, "
            "[threshold: number], [queryText: string])")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Float32Array queryVec = info[0].As<Napi::Float32Array>();
    int   k         = info[1].As<Napi::Number>().Int32Value();
    float threshold = 0.5f;

    if (info.Length() >= 3 && info[2].IsNumber())
        threshold = info[2].As<Napi::Number>().FloatValue();

    std::vector<ScoredResult> results;

    // ── Dense: HNSW ──────────────────────────────────────────────────────
    if (hnswIndex_ && hnswIndex_->alg_hnsw_ && hnswIndex_->current_label_ > 0)
    {
        // HR-3: Normalize query vector to match normalized stored vectors.
        // HNSW IP-space: distance = 1 - inner_product(normalized_a, normalized_b)
        //                         = 1 - cosine_similarity
        // So similarity = 1 - distance is correct ONLY when both are normalized.
        auto normalizedQuery = L2Normalize(queryVec.Data(), dim_);

        auto hnswResults = hnswIndex_->alg_hnsw_->searchKnn(
            normalizedQuery.data(), k * 3
        );

        while (!hnswResults.empty())
        {
            auto top = hnswResults.top();
            hnswResults.pop();

            float similarity = 1.0f - top.first;
            if (similarity >= threshold)
            {
                auto idIt = hnswIndex_->meta_map_.find(top.second);
                if (idIt != hnswIndex_->meta_map_.end())
                {
                    ScoredResult r;
                    r.id            = idIt->second.id;
                    r.denseScore    = similarity;
                    r.sparseScore   = 0.0;
                    r.combinedScore = 0.0;
                    results.push_back(r);
                }
            }
        }
    }

    // ── Sparse: BM25 ─────────────────────────────────────────────────────
    if (!(info.Length() >= 4 && info[3].IsString()))
    {
        // No query text — return dense-only results
        std::sort(results.begin(), results.end(),
            [](const ScoredResult &a, const ScoredResult &b){
                return a.denseScore > b.denseScore;
            });
        if ((int)results.size() > k)
            results.resize(k);

        Napi::Array jsResults = Napi::Array::New(env, results.size());
        for (size_t i = 0; i < results.size(); i++)
        {
            Napi::Object obj = Napi::Object::New(env);
            obj.Set("id",            Napi::String::New(env, results[i].id));
            // HR-8: Use combinedScore field name for consistency with hybrid path
            obj.Set("combinedScore", Napi::Number::New(env, results[i].denseScore));
            obj.Set("denseScore",    Napi::Number::New(env, results[i].denseScore));
            obj.Set("sparseScore",   Napi::Number::New(env, 0.0));
            jsResults.Set(i, obj);
        }
        return jsResults;
    }

    std::string queryText        = info[3].As<Napi::String>().Utf8Value();
    std::vector<std::string> queryTokens = Tokenize(queryText);

    // Score dense hits with BM25
    for (auto &r : results)
    {
        auto docIt = docIndex_.find(r.id);
        if (docIt != docIndex_.end())
            r.sparseScore = BM25Score(documents_[docIt->second], queryTokens);
    }

    // ── Add BM25-only hits not found by HNSW ─────────────────────────────
    // HR-5: Use inverted index for O(terms) candidate lookup
    std::unordered_set<std::string> foundIds;
    foundIds.reserve(results.size());
    for (const auto &r : results)
        foundIds.insert(r.id);

    std::unordered_set<size_t> candidateIndices;
    for (const auto &term : queryTokens)
    {
        auto iit = invertedIndex_.find(term);
        if (iit != invertedIndex_.end())
            for (size_t idx : iit->second)
                candidateIndices.insert(idx);
    }

    for (size_t idx : candidateIndices)
    {
        const std::string &docId = documents_[idx].id;
        if (foundIds.count(docId)) continue;

        double bm25 = BM25Score(documents_[idx], queryTokens);
        if (bm25 > 0.0)
        {
            ScoredResult r;
            r.id            = docId;
            r.denseScore    = 0.0;
            r.sparseScore   = bm25;
            r.combinedScore = 0.0;
            results.push_back(r);
        }
    }

    // ── Normalize + combine ───────────────────────────────────────────────
    double maxDense = 0.0, maxSparse = 0.0;
    for (const auto &r : results)
    {
        if (r.denseScore  > maxDense)  maxDense  = r.denseScore;
        if (r.sparseScore > maxSparse) maxSparse = r.sparseScore;
    }

    for (auto &r : results)
    {
        double normDense  = maxDense  > 0 ? r.denseScore  / maxDense  : 0.0;
        double normSparse = maxSparse > 0 ? r.sparseScore / maxSparse : 0.0;
        r.combinedScore   = denseWeight_ * normDense + (1.0 - denseWeight_) * normSparse;
    }

    std::sort(results.begin(), results.end(),
        [](const ScoredResult &a, const ScoredResult &b){
            return a.combinedScore > b.combinedScore;
        });

    if ((int)results.size() > k)
        results.resize(k);

    Napi::Array jsResults = Napi::Array::New(env, results.size());
    for (size_t i = 0; i < results.size(); i++)
    {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("id",            Napi::String::New(env, results[i].id));
        obj.Set("denseScore",    Napi::Number::New(env, results[i].denseScore));
        obj.Set("sparseScore",   Napi::Number::New(env, results[i].sparseScore));
        obj.Set("combinedScore", Napi::Number::New(env, results[i].combinedScore));

        auto docIt = docIndex_.find(results[i].id);
        if (docIt != docIndex_.end())
        {
            obj.Set("breadcrumb", Napi::String::New(env,
                documents_[docIt->second].breadcrumb));
            obj.Set("text", Napi::String::New(env,
                documents_[docIt->second].text.substr(0, 500)));
        }

        jsResults.Set(i, obj);
    }

    return jsResults;
}

// ==========================================
// NODE.JS: SPARSE SEARCH (BM25-only)
//
// HR-5: Pre-filter now uses invertedIndex_ — O(terms) lookup
//       instead of O(n×terms) full document scan.
// ==========================================
Napi::Value HybridRetriever::SparseSearch(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsNumber())
    {
        Napi::TypeError::New(env,
            "sparseSearch(query: string, k: number, minScore?: number)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string queryText = info[0].As<Napi::String>().Utf8Value();
    int    k        = info[1].As<Napi::Number>().Int32Value();
    double minScore = (info.Length() >= 3 && info[2].IsNumber())
                      ? info[2].As<Napi::Number>().DoubleValue()
                      : 0.0;

    if (documents_.empty())
        return Napi::Array::New(env, 0);

    std::vector<std::string> queryTokens = Tokenize(queryText);
    if (queryTokens.empty())
        return Napi::Array::New(env, 0);

    // HR-5: Use inverted index — O(terms) instead of O(n×terms)
    std::unordered_set<size_t> candidateIndices;
    for (const auto &term : queryTokens)
    {
        auto iit = invertedIndex_.find(term);
        if (iit != invertedIndex_.end())
            for (size_t idx : iit->second)
                candidateIndices.insert(idx);
    }

    if (candidateIndices.empty())
        return Napi::Array::New(env, 0);

    // Min-heap of size k
    using ScoredIdx = std::pair<double, size_t>;
    std::priority_queue<
        ScoredIdx,
        std::vector<ScoredIdx>,
        std::greater<ScoredIdx>> topK;

    for (size_t idx : candidateIndices)
    {
        double score = BM25Score(documents_[idx], queryTokens);
        if (score <= minScore)
            continue;

        if ((int)topK.size() < k)
            topK.push({score, idx});
        else if (score > topK.top().first)
        {
            topK.pop();
            topK.push({score, idx});
        }
    }

    // Extract descending
    std::vector<ScoredIdx> ordered;
    ordered.reserve(topK.size());
    while (!topK.empty())
    {
        ordered.push_back(topK.top());
        topK.pop();
    }
    std::sort(ordered.begin(), ordered.end(),
        [](const ScoredIdx &a, const ScoredIdx &b){
            return a.first > b.first;
        });

    Napi::Array out = Napi::Array::New(env, ordered.size());
    for (size_t i = 0; i < ordered.size(); i++)
    {
        const BM25Doc &doc = documents_[ordered[i].second];
        double score       = ordered[i].first;

        Napi::Object obj = Napi::Object::New(env);
        obj.Set("id",            Napi::String::New(env, doc.id));
        obj.Set("sparseScore",   Napi::Number::New(env, score));
        obj.Set("denseScore",    Napi::Number::New(env, 0.0));
        obj.Set("combinedScore", Napi::Number::New(env, score));
        obj.Set("breadcrumb",    Napi::String::New(env, doc.breadcrumb));
        out.Set(i, obj);
    }

    return out;
}

// ==========================================
// NODE.JS: REMOVE DOCUMENT
//
// HR-1: Replaced O(n) erase-from-middle with O(1) swap-with-last.
// HR-2: Selective IDF cache invalidation.
// HR-5: Inverted index maintenance.
// ==========================================
Napi::Value HybridRetriever::RemoveDocument(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString())
    {
        Napi::TypeError::New(env, "Expected (id: string)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string id = info[0].As<Napi::String>().Utf8Value();

    // HY-1: also remove the document's vector from the HNSW index.
    // Previously only the BM25 side was cleaned — the stale vector kept
    // matching dense queries forever (returning ids for content that the
    // JS pipeline had deleted/invalidated), and the index grew unboundedly
    // across re-index cycles (workspaceMapper force:true, post-patch
    // reindex, EW-3 vault re-chunking).
    removeFromHnsw(id);

    auto it = docIndex_.find(id);

    if (it != docIndex_.end())
    {
        size_t idx = it->second;
        const BM25Doc &doc = documents_[idx];

        totalDocLen_ -= doc.docLength;

        // HR-2: Selective cache invalidation
        for (const auto &[term, _] : doc.termFreq)
            idfCache_.erase(term);

        // HR-5: Remove from inverted index
        removeFromInvertedIndex(idx, doc);

        // HR-1: O(1) swap-with-last
        size_t lastIdx = documents_.size() - 1;
        if (idx != lastIdx)
        {
            // Update inverted index for the moved document
            for (const auto &[term, _] : documents_[lastIdx].termFreq)
            {
                auto iit = invertedIndex_.find(term);
                if (iit != invertedIndex_.end())
                    for (auto &entry : iit->second)
                        if (entry == lastIdx) { entry = idx; break; }
            }

            documents_[idx] = std::move(documents_[lastIdx]);
            docIndex_[documents_[idx].id] = idx;
        }
        documents_.pop_back();
        docIndex_.erase(id);
        totalDocs_--;

        avgDocLen_ = totalDocs_ > 0
                     ? (double)totalDocLen_ / totalDocs_
                     : 0.0;

        return Napi::Boolean::New(env, true);
    }

    return Napi::Boolean::New(env, false);
}

// ==========================================
// NODE.JS: GET STATISTICS
// ==========================================
Napi::Value HybridRetriever::GetStats(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    Napi::Object stats = Napi::Object::New(env);
    stats.Set("totalDocuments",     Napi::Number::New(env, totalDocs_));
    stats.Set("averageDocLength",   Napi::Number::New(env, avgDocLen_));
    stats.Set("denseWeight",        Napi::Number::New(env, denseWeight_));
    stats.Set("embeddingDimension", Napi::Number::New(env, dim_));
    stats.Set("invertedIndexTerms", Napi::Number::New(env, invertedIndex_.size()));
    return stats;
}
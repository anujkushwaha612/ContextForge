// native/src/tfidf.cpp

#include <napi.h>
#include <cmath>
#include <algorithm>

Napi::Number NativeTfIdfCosine(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    // Validate argument count
    if (info.Length() != 3) {
        Napi::TypeError::New(
            env,
            "Expected 3 arguments: queryTF, docTF, idfs"
        ).ThrowAsJavaScriptException();

        return Napi::Number::New(env, 0.0);
    }

    // Validate typed arrays
    if (
        !info[0].IsTypedArray() ||
        !info[1].IsTypedArray() ||
        !info[2].IsTypedArray()
    ) {
        Napi::TypeError::New(
            env,
            "All arguments must be Float64Array"
        ).ThrowAsJavaScriptException();

        return Napi::Number::New(env, 0.0);
    }

    // Cast to Float64Array
    Napi::Float64Array queryTF =
        info[0].As<Napi::Float64Array>();

    Napi::Float64Array docTF =
        info[1].As<Napi::Float64Array>();

    Napi::Float64Array idfs =
        info[2].As<Napi::Float64Array>();

    const size_t len = queryTF.ElementLength();

    // Length validation
    if (
        docTF.ElementLength() != len ||
        idfs.ElementLength() != len
    ) {
        Napi::TypeError::New(
            env,
            "All arrays must have equal length"
        ).ThrowAsJavaScriptException();

        return Napi::Number::New(env, 0.0);
    }

    if (len == 0) {
        return Napi::Number::New(env, 0.0);
    }

    // Raw pointers (zero-copy)
    const double* qTF = queryTF.Data();
    const double* dTF = docTF.Data();
    const double* idf = idfs.Data();

    double dotProduct = 0.0;
    double queryMagnitude = 0.0;
    double docMagnitude = 0.0;

    // Hot loop
    for (size_t i = 0; i < len; ++i) {
        const double idfVal = idf[i];

        const double qWeight =
            qTF[i] * idfVal;

        const double dWeight =
            dTF[i] * idfVal;

        dotProduct += qWeight * dWeight;
        queryMagnitude += qWeight * qWeight;
        docMagnitude += dWeight * dWeight;
    }

    // Avoid division by zero
    if (
        queryMagnitude <= 0.0 ||
        docMagnitude <= 0.0
    ) {
        return Napi::Number::New(env, 0.0);
    }

    const double cosine =
        dotProduct /
        (std::sqrt(queryMagnitude) *
         std::sqrt(docMagnitude));

    // Clamp to valid cosine range
    const double clamped =
        std::max(-1.0,
        std::min(1.0, cosine));

    return Napi::Number::New(
        env,
        clamped
    );
}
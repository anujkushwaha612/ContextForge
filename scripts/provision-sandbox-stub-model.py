#!/usr/bin/env python3
"""
Sandbox-fallback embedder model for ContextForge pipeline smoke-tests.

Generates a VALID ONNX model + tokenizer.json at contextforge_models/ that
satisfies the native OnnxEmbedder's contract (inputs: input_ids,
attention_mask, token_type_ids [1,S] int64; output: last_hidden_state
[1,S,384] float32) so the full proxy pipeline can be exercised in
sandboxes where HuggingFace is unreachable (the real model comes from
scripts/setup-onnx.sh).

The "embedding" is deterministic but FAKE: a fixed 384-d random row scaled
by the sum of token ids plus the token ids themselves — same text gives
the same vector, different text gives different vectors. Sufficient to
exercise the embed → HNSW → retrieve pipeline end-to-end; NOT a real
embedding model (semantic quality is meaningless).

Usage:  python3 scripts/provision-sandbox-stub-model.py
"""
import os
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(REPO, "contextforge_models")
os.makedirs(OUT_DIR, exist_ok=True)

DIM = 384
rng = np.random.default_rng(42)
W = (rng.standard_normal((1, DIM)) / np.sqrt(DIM)).astype(np.float32)

input_ids = helper.make_tensor_value_info("input_ids", TensorProto.INT64, [1, None])
attention_mask = helper.make_tensor_value_info("attention_mask", TensorProto.INT64, [1, None])
token_type_ids = helper.make_tensor_value_info("token_type_ids", TensorProto.INT64, [1, None])
last_hidden = helper.make_tensor_value_info("last_hidden_state", TensorProto.FLOAT, [1, None, DIM])

nodes = [
    helper.make_node("Cast", ["input_ids"], ["ids_f"], to=TensorProto.FLOAT),
    helper.make_node("ReduceSum", ["ids_f", "axes_1"], ["fp"], keepdims=1),
    helper.make_node("Gemm", ["fp", "W"], ["vec"], alpha=1.0, beta=0.0, transB=0),
    helper.make_node("Unsqueeze", ["vec", "axes_mid"], ["vec3"]),
    helper.make_node("Unsqueeze", ["ids_f", "axes_last"], ["ids3"]),
    helper.make_node("Add", ["vec3", "ids3"], ["last_hidden_state"]),
]
initializers = [
    numpy_helper.from_array(np.array([1], dtype=np.int64), "axes_1"),
    numpy_helper.from_array(W, "W"),
    numpy_helper.from_array(np.array([1], dtype=np.int64), "axes_mid"),
    numpy_helper.from_array(np.array([2], dtype=np.int64), "axes_last"),
]
graph = helper.make_graph(
    nodes, "stub_embedder",
    [input_ids, attention_mask, token_type_ids],
    [last_hidden], initializers,
)
model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
model.ir_version = 8
onnx.checker.check_model(model)
onnx.save(model, os.path.join(OUT_DIR, "all-MiniLM-L6-v2-int8.onnx"))

vocab = {"[PAD]": 0, "[UNK]": 100, "[CLS]": 101, "[SEP]": 102, "[MASK]": 103}
words = """the be of and a to in we can you it that is for on with as by or are was were this have
from at which but not they her him their there all any both each few more most other some such no nor
only own same so than too very will would should could may might must shall if then else when where why
how what who whom which while about into over under again further once here new file function class method
return const let var async await import export from default if else for while do switch case break continue
throw try catch finally this self super public private static void int float double string bool boolean null
undefined true false def end fn pub struct impl use mod type interface enum extends implements package
namespace using require module exports process env http https get post put patch delete request response
error exception trace debug info warn log print console window document object array map set json xml yaml
toml csv sql select insert update delete from where order group limit join inner left right outer on and or
not test tests describe expect jest mocha chai assert equal deep strict git branch commit push pull merge
rebase stash status log diff add rm mv cp mkdir touch cat grep sed awk echo curl wget npm yarn pnpm node
python pip docker compose kubernetes k8s nginx redis postgres mysql mongo sqlite server client api auth
token user role permission session login logout tokenize embedding vector cache index search query result
results data model train predict inference batch size dim dimension hidden state upload file download s3
bucket cloudfront signed presigned multipart directory folder share invite owner viewer editor"""
for i, w in enumerate(words.split()):
    if w not in vocab:
        vocab[w] = 104 + i
for i, c in enumerate(list(".,;:!?'\"()[]{}<>-=_/\\@#$%^&*~`|+ ")):
    key = c if c.strip() else " "
    if key not in vocab:
        vocab[key] = 500 + i
for suf in ["ing", "ed", "s", "es", "ly", "tion", "ment", "er", "est", "ness"]:
    key = "##" + suf
    if key not in vocab:
        vocab[key] = 900 + len(suf) * 7

with open(os.path.join(OUT_DIR, "tokenizer.json"), "w") as f:
    json_dump = {"model": {"type": "wordpiece", "vocab": vocab}}
    import json
    json.dump(json_dump, f)

print(f"[stub-model] wrote {OUT_DIR}/all-MiniLM-L6-v2-int8.onnx + tokenizer.json ({len(vocab)} tokens)")
print("[stub-model] NOTE: stub embeddings are deterministic but NOT semantically meaningful.")

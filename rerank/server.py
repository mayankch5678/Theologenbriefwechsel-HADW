"""Cross-encoder rerank sidecar for the ThBw RAG prototype.

The Node server has no clean way to run a cross-encoder (Ollama does not
serve rerankers), so this tiny HTTP service wraps BAAI/bge-reranker-v2-m3 —
same model family as the bge-m3 embeddings, multilingual, 8k context. The
parallel rag/ v3 prototype measured recall 69% -> 92% from exactly this model.

    uv run --project rerank python rerank/server.py      # http://127.0.0.1:5056

The Node server probes /health on startup and simply skips reranking when
this service is not running — it is an optional precision layer, never a
dependency.
"""

from __future__ import annotations

import logging
import os

import torch
from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import CrossEncoder

MODEL_NAME = os.environ.get("RERANK_MODEL", "BAAI/bge-reranker-v2-m3")
PORT = int(os.environ.get("RERANK_PORT", "5056"))
MAX_LENGTH = int(os.environ.get("RERANK_MAX_LENGTH", "512"))  # regest + passage fit; halves latency vs 1024

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("rerank")

app = FastAPI(title="thbw-rerank")
_model: CrossEncoder | None = None


def get_model() -> CrossEncoder:
    global _model
    if _model is None:
        device = "mps" if torch.backends.mps.is_available() else "cpu"
        log.info("loading %s on %s", MODEL_NAME, device)
        _model = CrossEncoder(MODEL_NAME, max_length=MAX_LENGTH, device=device)
    return _model


class Doc(BaseModel):
    id: str
    text: str


class RerankRequest(BaseModel):
    query: str
    docs: list[Doc]


class Score(BaseModel):
    id: str
    score: float


class RerankResponse(BaseModel):
    model: str
    scores: list[Score]


@app.get("/health")
def health() -> dict[str, str | bool]:
    return {"ok": True, "model": MODEL_NAME, "loaded": _model is not None}


@app.post("/rerank", response_model=RerankResponse)
def rerank(req: RerankRequest) -> RerankResponse:
    if not req.docs:
        return RerankResponse(model=MODEL_NAME, scores=[])
    model = get_model()
    pairs = [(req.query, d.text) for d in req.docs]
    # Ask for sigmoid explicitly (sentence-transformers >= 3 picks an
    # activation per model config; applying our own on top squashed every
    # score to ~0.50): 0–1 relevance a threshold can be set against.
    probs = model.predict(
        pairs, activation_fn=torch.nn.Sigmoid(), show_progress_bar=False, convert_to_numpy=True
    )
    return RerankResponse(
        model=MODEL_NAME,
        scores=[Score(id=d.id, score=float(p)) for d, p in zip(req.docs, probs.tolist())],
    )


if __name__ == "__main__":
    import uvicorn

    get_model()  # load eagerly so the first request is not a 30 s stall
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")

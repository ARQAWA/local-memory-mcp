#!/usr/bin/env python3
import argparse
import json
import os
import sys
import traceback
from typing import Any


def load_reranker(model_path: str) -> Any:
    sys.path.insert(0, model_path)
    from rerank import MLXReranker  # type: ignore

    projector_path = os.path.join(model_path, "projector.safetensors")
    return MLXReranker(model_path=model_path, projector_path=projector_path)


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def rerank_payload(reranker: Any, payload: dict[str, Any]) -> dict[str, Any]:
    request_id = payload.get("id")
    query = payload.get("query")
    candidates = payload.get("candidates")
    if not isinstance(request_id, str):
        return {"id": request_id, "error": "request id must be a string"}
    if not isinstance(query, str) or not query.strip():
        return {"id": request_id, "error": "query must be a non-empty string"}
    if not isinstance(candidates, list):
        return {"id": request_id, "error": "candidates must be an array"}

    safe_candidates: list[dict[str, str]] = []
    documents: list[str] = []
    for item in candidates:
        if not isinstance(item, dict):
            continue
        candidate_id = item.get("id")
        text = item.get("text")
        if not isinstance(candidate_id, str) or not isinstance(text, str):
            continue
        safe_candidates.append({"id": candidate_id, "text": text})
        documents.append(text)

    if not safe_candidates:
        return {"id": request_id, "results": []}

    ranked = reranker.rerank(query, documents)
    results: list[dict[str, Any]] = []
    for row in ranked:
        index = row.get("index")
        score = row.get("relevance_score")
        if not isinstance(index, int) or index < 0 or index >= len(safe_candidates):
            continue
        if not isinstance(score, (int, float)):
            continue
        results.append({"id": safe_candidates[index]["id"], "score": float(score), "index": index})
    return {"id": request_id, "results": results}


def run_check(model_path: str) -> int:
    reranker = load_reranker(model_path)
    payload = {
        "id": "check",
        "query": "local memory reranker readiness",
        "candidates": [
            {"id": "relevant", "text": "Local Memory MCP uses Jina MLX reranking for context retrieval."},
            {"id": "irrelevant", "text": "A recipe for soup is unrelated to backend memory search."},
        ],
    }
    emit(rerank_payload(reranker, payload))
    return 0


def run_worker(model_path: str) -> int:
    try:
        reranker = load_reranker(model_path)
    except Exception:
        traceback.print_exc(file=sys.stderr)
        return 1

    emit({"type": "ready", "model_path": model_path})
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
            if not isinstance(payload, dict):
                emit({"id": None, "error": "payload must be a JSON object"})
                continue
            emit(rerank_payload(reranker, payload))
        except Exception as exc:
            request_id = None
            try:
                parsed = json.loads(line)
                if isinstance(parsed, dict):
                    request_id = parsed.get("id")
            except Exception:
                pass
            emit({"id": request_id, "error": str(exc)})
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Jina MLX reranker JSONL worker")
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        return run_check(args.model_path)
    return run_worker(args.model_path)


if __name__ == "__main__":
    raise SystemExit(main())

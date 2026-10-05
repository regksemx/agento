from __future__ import annotations

import threading
from collections import deque


class LatencyStats:
    """Thread-safe sliding window of request latencies in milliseconds."""

    def __init__(self, maxlen: int = 1024) -> None:
        self._lock = threading.Lock()
        self._window: deque[float] = deque(maxlen=maxlen)
        self._count = 0

    def record(self, ms: float) -> None:
        with self._lock:
            self._window.append(float(ms))
            self._count += 1

    @staticmethod
    def _pct(sorted_vals: list[float], q: float) -> float:
        # linear interpolation between closest ranks
        if len(sorted_vals) == 1:
            return sorted_vals[0]
        pos = q * (len(sorted_vals) - 1)
        lo = int(pos)
        hi = min(lo + 1, len(sorted_vals) - 1)
        return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (pos - lo)

    def snapshot(self) -> dict:
        with self._lock:
            vals = sorted(self._window)
            count = self._count
        if not vals:
            return {"count": count, "window": 0, "p50_ms": None, "p95_ms": None, "max_ms": None}
        return {
            "count": count,
            "window": len(vals),
            "p50_ms": round(self._pct(vals, 0.50), 3),
            "p95_ms": round(self._pct(vals, 0.95), 3),
            "max_ms": round(vals[-1], 3),
        }

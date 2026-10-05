import threading

from agento_brain.stats import LatencyStats


def test_empty_snapshot():
    s = LatencyStats().snapshot()
    assert s["p50_ms"] is None and s["count"] == 0


def test_percentiles():
    st = LatencyStats()
    for v in range(1, 101):
        st.record(v)
    s = st.snapshot()
    assert s["count"] == 100 and s["max_ms"] == 100
    assert abs(s["p50_ms"] - 50.5) < 1e-6
    assert abs(s["p95_ms"] - 95.05) < 1e-6


def test_window_and_threads():
    st = LatencyStats(maxlen=50)
    ts = [threading.Thread(target=lambda: [st.record(1.0) for _ in range(100)]) for _ in range(8)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    s = st.snapshot()
    assert s["count"] == 800 and s["window"] == 50

import os
import sys

_status = {"code": 0}


def pytest_sessionfinish(session, exitstatus):
    _status["code"] = int(exitstatus)


def pytest_unconfigure(config):
    # onnxruntime/tokenizers can abort at interpreter exit on macOS (libc++ mutex teardown), turning a green run red.
    if sys.platform == "darwin":
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(_status["code"])

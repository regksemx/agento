"""Where Laya's training primitives come from.

The pinned git revision of laya (see pyproject.toml) ships `laya.train`, the one shared RLCD fine-tuning loop of the
upstream notebooks. The PyPI wheel of 0.3.27 does not, so when `laya.train` cannot be imported we fall back to
`_laya_port.py`, a verbatim vendored copy of it. Either way `lt` has the same functions: `TrainConfig`, `to_internal`,
`target_from_gold`, `make_item`, `encode_item`, `draw_option_order`, `rlcd_loss`, `soft_ce_loss`, `sigma_at`,
`train_model`, `load_checkpoint`, `save_checkpoint`, `calibration_records`, `resolve_device`.
`AGENTO_FORCE_LAYA_PORT=1` forces the vendored copy (used by the tests).
"""
from __future__ import annotations

import os


def load_train():
    """`(module, "library" | "port")`."""
    if os.environ.get("AGENTO_FORCE_LAYA_PORT") != "1":
        try:
            from laya import train as lt  # type: ignore

            return lt, "library"
        except ImportError:
            pass
    from . import _laya_port as lt

    return lt, "port"

"""Backend adapters for the target-control domain.

Each module here wraps exactly one vendor tool (pyOCD, OpenOCD, J-Link, ...)
behind the ``boardex_core.TargetController`` interface (Adapter pattern).
"""

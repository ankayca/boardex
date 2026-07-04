"""Backend adapters for the logic-analyzer domain.

Each module here wraps exactly one vendor tool (sigrok/libsigrok, and future
custom drivers) behind the ``boardex_core.LogicAnalyzer`` interface (Adapter
pattern). All vendor-specific quirks stay quarantined in these files.
"""

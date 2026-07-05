"""Unit tests for structured I2C transaction parsing. No hardware."""

from __future__ import annotations

from boardex_logic.decode import decode_transactions, i2c


def _ann(text: str) -> dict:
    return {"decoder": "i2c", "text": text}


def test_parse_simple_address_write():
    annotations = [
        _ann("START"),
        _ann("ADDRESS WRITE: 48"),
        _ann("STOP"),
    ]
    tx = i2c.parse_transactions(annotations)
    assert len(tx) == 1
    assert tx[0]["addr_7bit"] == 0x24
    assert tx[0]["rw"] == "w"
    assert tx[0]["nack_at"] is None


def test_parse_bmp180_chip_id_read():
    """Typical BMP180 register read: write 0xD0, repeated start, read 0x55."""
    text = """\
START
ADDRESS WRITE: EE
DATA WRITE: D0
ACK
START REPEAT
ADDRESS READ: EF
DATA READ: 55
NACK
STOP
"""
    annotations = [_ann(line) for line in text.strip().splitlines()]
    tx = i2c.parse_transactions(annotations)
    assert len(tx) == 2
    assert tx[0] == {
        "addr_7bit": 0x77,
        "rw": "w",
        "write": [0xD0],
        "read": [],
        "nack_at": None,
    }
    assert tx[1] == {
        "addr_7bit": 0x77,
        "rw": "r",
        "write": [],
        "read": [0x55],
        "nack_at": None,
    }


def test_parse_address_nack():
    annotations = [
        _ann("START"),
        _ann("ADDRESS WRITE: EE NACK"),
        _ann("STOP"),
    ]
    tx = i2c.parse_transactions(annotations)
    assert tx[0]["nack_at"] == "address"


def test_match_expectations_bmp180():
    transactions = [
        {"addr_7bit": 0x77, "rw": "w", "write": [0xD0], "read": [], "nack_at": None},
        {"addr_7bit": 0x77, "rw": "r", "write": [], "read": [0x55], "nack_at": None},
    ]
    expect = [
        {"addr_7bit": 0x77, "rw": "w", "write": [0xD0]},
        {"addr_7bit": 0x77, "rw": "r", "read": [0x55]},
    ]
    match = i2c.match_expectations(transactions, expect)
    assert match["matched"] is True
    assert match["matched_count"] == 2


def test_decode_transactions_router():
    assert decode_transactions("i2c", [_ann("START")]) == []
    assert decode_transactions("uart", [_ann("START")]) == []

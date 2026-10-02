from app.formatting import fr_num


def test_thousands_are_spaced_not_comma_separated():
    assert fr_num(2963.4) == "2\u202f963"
    assert fr_num(1_234_567) == "1\u202f234\u202f567"
    assert "," not in fr_num(20_000)


def test_decimals_use_a_comma():
    assert fr_num(354020.5, 2) == "354\u202f020,50"
    assert fr_num(12.34, 1) == "12,3"


def test_small_and_negative_numbers():
    assert fr_num(0) == "0"
    assert fr_num(999) == "999"
    assert fr_num(-58672) == "-58\u202f672"

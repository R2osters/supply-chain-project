"""Numbers as a French reader writes them, for the explanations the engines produce."""

#: Narrow no-break space: the thousands separator of French typography, and the one the
#: interface itself uses (Intl "fr-FR"), so engine texts and screens show the same figures.
_THOUSANDS = "\u202f"


def fr_num(value: float, decimals: int = 0) -> str:
    """`2963.4` → `2 963`; `354020.5, 2` → `354 020,50`. Never `2,963`, which reads as 2.963."""
    return f"{value:,.{decimals}f}".replace(",", _THOUSANDS).replace(".", ",")

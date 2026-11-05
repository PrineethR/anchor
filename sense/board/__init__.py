"""The Board: an infinite canvas for jamming, an added section of Anchor.

Everything about it lives in this package and in sense/web/board/, so it can be removed whole. app.py only hands it
the requests under /api/board and /web/board.
"""

from .api import BoardApp
from .store import NotFound

__all__ = ["BoardApp", "NotFound"]

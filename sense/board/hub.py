"""What is open right now: the browser tabs watching each board.

A tab subscribes with a server-sent-events stream. The server publishes a change (a save from another tab of the same
board) to every other tab on that board, so two windows on one board stay the same.
"""

from __future__ import annotations

import json
import queue
import threading


class Hub:
    def __init__(self):
        self.lock = threading.Lock()
        self.tabs: dict[str, dict[str, queue.Queue]] = {}

    def subscribe(self, bid: str, cid: str) -> queue.Queue:
        q: queue.Queue = queue.Queue()
        with self.lock:
            self.tabs.setdefault(bid, {})[cid] = q
        return q

    def unsubscribe(self, bid: str, cid: str, q: queue.Queue | None = None) -> None:
        """Forget a tab. Given its queue, only if that is still the tab's current stream: a page that reconnects keeps its
        client id, and the old stream ending later must not drop the new one."""
        with self.lock:
            tabs = self.tabs.get(bid)
            if not tabs or (q is not None and tabs.get(cid) is not q):
                return
            tabs.pop(cid, None)
            if not tabs:
                del self.tabs[bid]

    def viewers(self, bid: str) -> int:
        with self.lock:
            return len(self.tabs.get(bid, {}))

    def publish(self, bid: str, event: str, data: dict, exclude: str | None = None) -> None:
        msg = f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"
        with self.lock:
            targets = [q for cid, q in self.tabs.get(bid, {}).items() if cid != exclude]
        for q in targets:
            q.put(msg)

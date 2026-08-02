# Support bot

A small, real CLI that remembers each customer separately — the shape most
people actually build with Itsuki.

```bash
pip install itsuki
export ITSUKI_API_KEY=itsuki_live_...        # https://itsuki.app -> API keys

python bot.py --customer alice tell "My order 4471 shipped to the Porto office."
python bot.py --customer alice ask  "Where is my order going?"
python bot.py --customer bob   ask  "Where is my order going?"   # sees nothing of Alice's
python bot.py --customer alice chat                              # interactive
python bot.py customers
```

## The one idea

`--customer` becomes `user_id` on every call. One API key, one memory space
per end user, isolated on both save and recall. Alice's memory is unreachable
from Bob's session even if Bob asks using the exact words Alice used.

Memory lives in Itsuki, not in this process — kill it, start it again, and the
same customer still has their history.

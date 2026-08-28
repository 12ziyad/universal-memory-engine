-- Huba conversation threads.
--
-- The assistant kept its history in the browser tab, so closing the panel
-- lost the conversation and there was nothing to come back to. Threads make
-- a conversation an object a person can return to, pick between, and delete.
--
-- Content-light by construction: a thread stores what the person asked and
-- what Huba answered, nothing derived from their memory graph. Deleting the
-- account cascades; deleting a thread removes its messages.
CREATE TABLE IF NOT EXISTS huba_threads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT,
  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- The panel's thread list: this user's threads, most recent first.
CREATE INDEX IF NOT EXISTS idx_huba_threads_user_updated
  ON huba_threads(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS huba_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES huba_threads(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Replaying one thread in order, and scoped by user so a thread id alone can
-- never read another account's conversation.
CREATE INDEX IF NOT EXISTS idx_huba_messages_thread
  ON huba_messages(thread_id, created_at);

CREATE INDEX IF NOT EXISTS idx_huba_messages_user
  ON huba_messages(user_id, created_at DESC);

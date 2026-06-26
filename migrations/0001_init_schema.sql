-- Migration number: 0001 	 2026-06-24T13:28:33.150Z

CREATE TABLE users (
	id TEXT PRIMARY KEY,
	email TEXT,
	created_at INTEGER
);

CREATE TABLE nodes (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	label TEXT,
	category TEXT,
	role TEXT,
	state TEXT DEFAULT 'active',
	summary TEXT,
	created_at INTEGER,
	updated_at INTEGER
);

CREATE TABLE slices (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	node_id TEXT,
	text TEXT,
	kind TEXT,
	is_current INTEGER DEFAULT 1,
	created_at INTEGER
);

CREATE TABLE events (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	node_id TEXT,
	action TEXT,
	text TEXT,
	importance TEXT DEFAULT 'ordinary',
	happened_at INTEGER,
	created_at INTEGER
);

CREATE TABLE edges (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	from_node TEXT,
	to_node TEXT,
	type TEXT,
	created_at INTEGER
);

CREATE TABLE candidates (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	label TEXT,
	strength TEXT DEFAULT 'weak',
	mentions INTEGER DEFAULT 1,
	cluster_hint TEXT,
	created_at INTEGER
);

CREATE TABLE checkpoints (
	user_id TEXT PRIMARY KEY,
	last_processed_msg_id TEXT,
	updated_at INTEGER
);

CREATE INDEX idx_nodes_user_id ON nodes(user_id);
CREATE INDEX idx_slices_user_id ON slices(user_id);
CREATE INDEX idx_slices_node_id ON slices(node_id);
CREATE INDEX idx_events_user_id ON events(user_id);
CREATE INDEX idx_events_node_id ON events(node_id);
CREATE INDEX idx_edges_user_id ON edges(user_id);
CREATE INDEX idx_candidates_user_id ON candidates(user_id);

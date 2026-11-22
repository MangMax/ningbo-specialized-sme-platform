CREATE INDEX log_timestamp ON log_events (timestamp, seq);
CREATE INDEX log_level ON log_events (level, seq);
CREATE INDEX log_source ON log_events (source, seq);
CREATE INDEX log_operation ON log_events (operation, seq);
CREATE INDEX "log_requestId" ON log_events ("requestId", seq);

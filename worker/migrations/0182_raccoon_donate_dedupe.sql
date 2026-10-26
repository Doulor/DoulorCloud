-- 小浣熊捐献记录去重（2026-10-26）
--
-- 问题：同一个号重复捐献（或重复点书签）会在 raccoon_donations 里插多条，
-- 「我的捐献记录」看着像捐了好几个号，实际池子里只有一个。
-- 做法：先清理历史重复（保留每个 account_id 最新的一条），再加唯一索引兜住后续写入。

DELETE FROM raccoon_donations
WHERE account_id IS NOT NULL
  AND rowid NOT IN (
    SELECT MAX(rowid) FROM raccoon_donations
    WHERE account_id IS NOT NULL
    GROUP BY account_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_raccoon_donations_account
  ON raccoon_donations(account_id)
  WHERE account_id IS NOT NULL;

const Database = require('better-sqlite3')
const os = require('node:os')
const path = require('node:path')

const dbPath = path.join(os.homedir(), '.geekgeekrun', 'storage', 'public.db')
const db = new Database(dbPath, { readonly: true })

const tables = db
  .prepare("select name, type from sqlite_master where type in ('table','view') order by type,name")
  .all()

const counts = []
for (const table of tables) {
  try {
    counts.push({
      ...table,
      count: db.prepare(`select count(*) as c from ${JSON.stringify(table.name)}`).get().c,
    })
  } catch (error) {
    counts.push({ ...table, error: error.message })
  }
}

console.log(JSON.stringify({ dbPath, counts }, null, 2))

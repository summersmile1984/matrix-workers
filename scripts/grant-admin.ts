import { createClient } from "@libsql/client/http";
const client = createClient({ url: "http://localhost:8080" });
await client.execute("UPDATE users SET admin = 1 WHERE user_id = '@admin:hs.localhost'");
console.log("Admin rights granted to @admin:hs.localhost");

import { createClient } from "@libsql/client/http";
const client = createClient({ url: "http://localhost:8080" });
const result = await client.execute("SELECT * FROM appservice_registrations");
console.log(result.rows);

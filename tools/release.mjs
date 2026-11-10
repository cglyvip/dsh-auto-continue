// 发布 GitHub Release：node tools/release.mjs <tag> <标题> <body文件>
import fs from "node:fs";
import { execSync } from "node:child_process";

const [tag, title, bodyFile] = process.argv.slice(2);
if (!tag || !title || !bodyFile) {
	console.error("用法: node tools/release.mjs <tag> <标题> <body文件>");
	process.exit(1);
}
const token = execSync('printf "protocol=https\\nhost=github.com\\n\\n" | git credential fill', { encoding: "utf8", shell: "C:/Program Files/Git/bin/bash.exe" })
	.split("\n").find((l) => l.startsWith("password="))?.slice(9);
if (!token) { console.error("NO_TOKEN"); process.exit(1); }

const body = fs.readFileSync(bodyFile, "utf8");
const res = await fetch("https://api.github.com/repos/cglyvip/dsh-auto-continue/releases", {
	method: "POST",
	headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
	body: JSON.stringify({ tag_name: tag, target_commitish: "main", name: title, body, draft: false, prerelease: false }),
});
const j = await res.json();
if (j.html_url) console.log("RELEASE OK:", j.html_url);
else { console.error("ERR:", JSON.stringify(j).slice(0, 400)); process.exit(1); }

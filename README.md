# Apple Mail + Gmail Server Read-only MCP — v0.3.0

อัปเดตและทดสอบเมื่อ 1 พฤศจิกายม 2026 เพิ่มการป้องกัน Mail ค้างจากงานดึงปริมาณมาก และเครื่องมือดึงตรงจาก Gmail แบบ resumable ที่ไม่โดน rate-limit บล็อก (pacing + backoff) พร้อมช่องทาง bulk สำหรับบัญชีที่ไม่มี API เช่น Hotmail/Exchange ผ่าน bridge ที่คุมจังหวะแล้ว ยังคงอ่านอย่างเดียวเช่นเดิม

## ผลตรวจรุ่น 0.3.0

- Unit tests ผ่าน **31/31** (รวมชุดใหม่: pacing/MAIL_BUSY/cooldown, bulkRead, policy backoff/token-bucket, sync cursor/resume/history_expired, bulk job resume)
- Live gate ผ่านทั้งสองชุด: bridge (16 tools, 3 บัญชี, ทดสอบครบ 2 บัญชี, `since` ทำงานตรง) และ Gmail API (inventory 8,044/8,044 ตรง `verified_message_inventory`, sync `up_to_date`, bulk fetch 3/3, bulk download 1, **Hotmail ผ่าน bridge อ่านได้จริง**)
- ข้อสังเกตสภาพแวดล้อม: บัญชี Gmail ส่วนตัวบัญชีหนึ่งใน Mail สาขา IMAP กำลังล่าช้าอยู่ (INBOX อ่านไม่ได้ช่วงทดสอบ ทั้งโค้ดเก่าและใหม่) จึงถูกข้ามพร้อมรายงานใน gate — ไม่ใช่ผลจากรุ่นนี้
- **โหลดเทสบัญชี Hotmail/Exchange ผ่าน bridge (`test/exchange-load.mjs`)**: Inbox 2,360 ฉบับ — เดิน metadata 300 แถว (6 หน้า×50), อ่านเนื้อหา 30 ฉบับ (3 ชุด×10) ผ่าน `bulk_read_messages` ไม่มีที่ล้ม, ยิง 12 call พร้อมกันได้ 8 สำเร็จ + 4 โดน `MAIL_BUSY` (คิวทำงานตามขอบเขต) **ไม่มี timeout หรือค้างแม้แต่ครั้งเดียว** และ Mail ยังตอบสนองทันทีหลังโหลด (call ช้าสุด 15.6 วิ อยู่ในงบ 20 วิ)
- MCP server ที่รันอยู่ในแชตเดิมยังเป็นโปรเซสโค้ดเก่า; เปิดเซสชันใหม่หรือ reconnect MCP จึงจะได้เครื่องมือ 16 ตัว

## สิ่งที่เปลี่ยนในรุ่น 0.3.0

- **Bridge มี pacing กัน Mail ค้าง**: คิว osascript จำกัดความลึก (ค่าเริ่ม 8 เกินปุ๊บได้ `MAIL_BUSY`), เรียกห่างกัน ≥250ms, หลัง timeout หยุดพัก 5 วินาทีก่อนเรียกถัดไป (cooldown — ไม่ retry), และการดึงรายการเมลใช้ `properties()` รวม Apple Events ต่อแถวลงราว 4 เท่า ปรับด้วย env: `MAIL_MCP_MAX_PENDING`, `MAIL_MCP_MIN_INTERVAL_MS`, `MAIL_MCP_COOLDOWN_MS`
- **ทุก request ขอ Gmail วิ่งผ่านชั้น policy** (`policy.mjs`): token bucket 40 units/วินาที (burst 50 « โควตา 250), retry 429/5xx สูงสุด 3 ครั้งแบบ exponential backoff + jitter (สูงสุด 8 วินาที), เคารพ `Retry-After` แต่ถ้าเกินงบของ call จะ fail fast เป็น `GMAIL_RATE_LIMITED` — ไม่มี sleep ยาวใน MCP call; timeout แยกเป็น `GMAIL_TIMEOUT` env: `GMAIL_UNITS_PER_SECOND`, `GMAIL_MAX_ATTEMPTS`, `GMAIL_TIMEOUT_MS`
- **เครื่องมือใหม่ 4 ตัว**: `server_sync_mailbox` (History API — เฉพาะเมลใหม่/เปลี่ยน, cursor ขยับเฉพาะเมื่ออ่านครบ), `server_bulk_fetch_messages` (≤50 id/call, metadata + fields mask เป็นค่าเริ่ม, resume ด้วย `job_id`), `server_bulk_download_attachments` (≤20 ชิ้น/call, resume ข้ามที่เสร็จแล้ว), `bulk_read_messages` (Apple Mail ≤10 ฉบับ/call สำหรับบัญชีไม่มี API เช่น Hotmail)
- **`list_messages` เพิ่ม `since`** (ISO 8601): หยุดไล่เมื่อเจบเมลเก่ากว่า (Mail เรียงใหม่→เก่า) งาน "เอาเฉพาะเมลใหม่" ไม่ต้องเดินทั้งกล่อง — ใช้ได้ทุกบัญชีใน Mail
- **เส้นทางงาน bulk**: บัญชี Gmail องค์กร → ใช้กลุ่ม `server_*`; Hotmail/M365/บัญชีอื่น → bridge แบบ paced (`list_messages` + `bulk_read_messages` + `download_attachment` รายชิ้น) ช้ากว่า API แต่ไม่ทำให้ Mail ค้าง ต้องเปิด Mail.app ค้างไว้ และไม่มี full-text search
- **ข้อตัดสินใจ**: ไม่ใช้ Microsoft Graph API / IMAP-OAuth สำหรับ Hotmail ตามคำตัดสินใจของเจ้าของเครื่อง — การเพิ่ม adapter ในอนาคตต้องขออนุมัติแยก (app registration + consent ต่อบัญชี)
- job/state ของเครื่องมือใหม่เก็บเฉพาะ ID/สถานะ/path/hash ที่ `server-data/*.json` (0600, atomic) — ไม่เก็บเนื้อหาเมลหรือไฟล์แนบลง state เด็ดขาด

## เครื่องมือฝั่งเซิร์ฟเวอร์ (Gmail API)

ดูตารางเครื่องมือทั้งหมด (รวม 4 ตัวใหม่ของรุ่น 0.3.0) ที่หัวข้อ "ใช้เครื่องมือฝั่งเซิร์ฟเวอร์" ด้านล่าง

## ติดตั้งบนเครื่องอื่น

1. ต้องมี macOS พร้อมแอป Mail และ Node.js ≥ 18
2. `git clone` แล้วรัน `npm install` ในโปรเจกต์ (ติดตั้ง MCP SDK 1.30.0 + zod ลง `node_modules` ของโปรเจกต์เอง — `runtime.mjs` จะใช้ตัวนี้ก่อนอัตโนมัติ)
3. ลงทะเบียนกับ Claude Code: `claude mcp add --scope user apple-mail-readonly -- node /เส้นทาง/clone/server.mjs`
4. ครั้งแรกที่เรียกเครื่องมือ Apple Mail, macOS จะถามสิทธิ์ Automation ให้ผู้ใช้อนุญาตเอง (เซิร์ฟเวอร์ไม่แตะ TCC)
5. ฝั่ง Gmail API ต้องมี credential ของเครื่องนั้นเองที่ `~/.gmail-readonly-mcp/{gcp-oauth.keys.json,token.json}` — ทำสิทธิ์ read-only ต่อเครื่อง ไม่คัดลอก token ข้ามเครื่อง ถ้าไม่มี เครื่องมือกลุ่ม `server_*` จะตอบ `GMAIL_AUTH_NOT_CONFIGURED` ส่วนเครื่องมือ Apple Mail ใช้ได้ปกติ
6. กรณีไม่ต้องการ `npm install`: ชี้ไปยัง package root ที่ติดตั้ง dependency ไว้แล้วด้วย env `MAIL_MCP_DEPS_ROOT`
7. ปุ่มปรับตามเครื่อง (env): `MAIL_MCP_MAX_PENDING`, `MAIL_MCP_MIN_INTERVAL_MS`, `MAIL_MCP_COOLDOWN_MS`, `GMAIL_UNITS_PER_SECOND`, `GMAIL_MAX_ATTEMPTS`, `GMAIL_TIMEOUT_MS`
8. สำหรับ Codex CLI ใช้ launcher `sh codex-with-mail.sh` (อ้างตำแหน่งเทียบกับตัวสคริปต์เอง ใช้ได้ทุกเครื่อง)

ข้อมูลส่วนตัวที่ถูกกันออกจาก git ทั้งหมด: `server-data/` (manifest/job/sync + ไฟล์ที่ดาวน์โหลด), `downloads/`, `SERVER_VERIFICATION.json`, `.codex/` — repo มีแค่โค้ด เทสต์ และเอกสาร

## ผลตรวจรุ่น 0.2.0

- มี 12 tools: Apple Mail เดิม 7 ตัว และ Gmail server 5 ตัว
- บัญชีองค์กรที่เชื่อม API: สแกน unique message ID ได้ **8,014 รายการ / 17 หน้า** รวม Spam และ Trash
- จำนวนตรงกับ `messagesTotal` ทั้งก่อนและหลังสแกน และ `historyId` ไม่เปลี่ยน: `verified_message_inventory`
- เป็นหลักฐานว่ารายการ message ID ที่ Gmail API เปิดให้บัญชีนี้เห็นครบ ณ เวลาสแกน **ไม่ใช่การดาวน์โหลดเนื้อหา/ไฟล์แนบครบทุกฉบับ** และไม่รวมข้อมูลที่ลบถาวรหรือเก็บในระบบ retention ของผู้ดูแล
- อ่านเนื้อหาจาก API จริง 3 ฉบับและตรวจสถานะ UNREAD ไม่เปลี่ยน ดาวน์โหลดไฟล์แนบจาก API จริง 1 ไฟล์พร้อมตรวจขนาดและ SHA-256
- Tests ผ่าน 13/13; MCP protocol ผ่าน; รายงานอยู่ใน `SERVER_VERIFICATION.json`
- ไม่ได้แก้ global config หรือเปิดเครื่องมือเข้าแชต Desktop นี้โดยอัตโนมัติ ตัว launcher เดิมชี้เข้า server ที่อัปเดตแล้ว

## ใช้เครื่องมือฝั่งเซิร์ฟเวอร์

| Tool | การใช้งาน |
| --- | --- |
| `server_mail_status` | ตรวจบัญชีที่เชื่อมกับ API และจำนวนข้อความบนเซิร์ฟเวอร์ |
| `server_list_messages` | อ่านรายการหรือค้นหา Gmail โดยตรง รวม Spam/Trash; ส่ง `page_token` จาก `next_page_token` จนหมด |
| `server_read_message` | อ่านเนื้อหาและรายการ MIME parts ด้วย `message_id` ที่ได้จาก API |
| `server_download_attachment` | ใช้ `message_id` และ `part_key` จาก read เพื่อดาวน์โหลดจากเซิร์ฟเวอร์ แม้ยังไม่มีใน Apple Mail |
| `server_scan_mailbox` | สแกนทุก message ID พร้อม checkpoint; เรียกต่อด้วย `scan_id` จน status เปลี่ยนจาก scanning |
| `server_sync_mailbox` | **ใหม่ 0.3.0** sync เฉพาะเมลใหม่/เปลี่ยน/ถูกลบด้วย History API; cursor ขยับเฉพาะเมื่ออ่านครบ ครั้งแรกได้ `initial_baseline`; `history_expired` → สแกนใหม่ก่อน |
| `server_bulk_fetch_messages` | **ใหม่ 0.3.0** ดึง ≤50 ฉบับ/call ตาม ID (จาก scan/sync/list); เริ่มด้วย `metadata` + fields mask ก่อน; 404 รายฉบับข้ามได้; ต่อด้วย `job_id` |
| `server_bulk_download_attachments` | **ใหม่ 0.3.0** ดาวน์โหลด ≤20 ชิ้น/call จาก `{message_id, part_key}`; resume ข้ามชิ้นที่เสร็จ; จำกัด 25 MiB/ไฟล์ |

**ID ของ Gmail API และ ID ของ Apple Mail เป็นคนละชุด ห้ามใช้ข้ามกัน** เครื่องมือ server ทั้งห้าใช้บัญชีที่ OAuth อนุญาตอยู่ใน `~/.gmail-readonly-mcp` เท่านั้น ตรวจชื่อบัญชีด้วย `server_mail_status` ก่อนใช้งาน

การสแกนไม่มี query filter และเปิด `includeSpamTrash=true` เสมอ ไม่บวกจำนวนตาม label เพราะเมลเดียวมีได้หลาย label สแกนหน้าละ 500 รายการ สูงสุด 5 หน้าต่อคำขอ เก็บเฉพาะ ID และข้อมูลตรวจความครบถ้วนใน `server-data/*.json` สิทธิ์ไฟล์ 0600 โฟลเดอร์ 0700

สถานะ `changed_during_scan` หรือ `count_mismatch` **ห้ามถือว่าตรวจครบแล้ว** ให้สแกนใหม่เมื่อ mailbox นิ่ง หากเป็น `interrupted` ให้ตรวจ `last_error` แล้วใช้ scan_id เดิมต่อหลังแก้สาเหตุ ระบบไม่ retry rate-limit อัตโนมัติ การ resume scan เดียวกันควรทำทีละ client; ข้ามหลาย server process ยังไม่มี distributed lock

ไฟล์แนบ/ส่วนข้อความส่งออกลง `server-data/download-*/` ชื่อปลอดภัย ไม่เขียนทับ สูงสุด 25 MiB ต่อไฟล์ อ่านข้อความจำกัดความยาวและรายงาน `truncated` ส่วน plain text ที่เก็บใน attachment endpoint จะโหลดให้สูงสุด 4 ส่วนภายในเพดานรวม 25 MiB หากยังไม่ครบจะรายงาน `text_body_external`; HTML-only ให้ดาวน์โหลด part ที่ MIME type เป็น text/html เพื่ออ่านเป็นข้อมูล ไม่ execute เนื้อหา

ใช้ OAuth ที่มีอยู่ผ่าน runtime โดยไม่พิมพ์ credential ไม่แก้ token file และไม่เพิ่มสิทธิ์ใหม่ เซิร์ฟเวอร์บังคับ Gmail เป็น GET-only; POST ใช้เฉพาะการ refresh OAuth กับ Google เท่านั้น ไม่อ้างว่า scope ของ credential เดิมมีเฉพาะ read-only เพราะไฟล์เก่าอาจไม่มี scope metadata

## ผลตรวจ Apple Mail รุ่นแรก

## สถานะ

- MCP ผ่าน stdio: ทดสอบ initialize, tools/list และ tools/call สำเร็จ
- พบ 2 บัญชี และ 37 โฟลเดอร์ระดับแรก
- อ่านตัวอย่างเมลจริง 2 บัญชี: สถานะ unread ก่อนและหลังไม่เปลี่ยนทั้ง 2 ตัวอย่าง
- อ่านข้อมูลไฟล์แนบ 5 รายการ และส่งออกไฟล์แนบจริง 1 ไฟล์สำเร็จ ตรวจขนาดและ SHA-256 แล้ว
- Unit tests 5 ข้อผ่าน รวมการป้องกัน path traversal, การจำกัดขนาด, ไม่เขียนทับ และการซ่อนรายละเอียด error
- สร้าง config ระดับโปรเจกต์ไว้ใน `.codex/config.toml` แล้ว ยังไม่ได้แก้ global Codex config หรือโหลดเครื่องมือเข้าแชตปัจจุบัน

## เปิดใช้

มี launcher สำหรับ Codex CLI ที่ส่ง config เฉพาะโปรเซสโดยไม่แก้ global config:

```sh
sh /Users/paranee/Documents/Codex/2026-10-29/new-chat-2/outputs/apple-mail-mcp/codex-with-mail.sh
```

ตรวจ config ด้วย `sh codex-with-mail.sh mcp get apple-mail-readonly --json` ได้ การเปิด interactive chat ผ่าน launcher และการโหลดใน Codex desktop ยังไม่ได้ทดสอบในรอบนี้; MCP server ได้ทดสอบจริงด้วย SDK client แล้ว

การทดลอง `codex -C <project> mcp get apple-mail-readonly --json` โดยอาศัย `.codex/config.toml` เพียงอย่างเดียวไม่พบ server จึงยังถือว่า project config ไม่ถูกโหลดในบริบทปัจจุบัน ใช้ launcher ด้านบนเพื่อส่ง config โดยตรงแทน ไม่อ้างว่าเครื่องมือถูกเพิ่มในแชตปัจจุบันแล้ว

หากต้องการเปิดใช้ทั้งระบบ ต้องเพิ่ม config ของ server นี้ใน global config แยกต่างหาก ยังไม่ได้ดำเนินการในรอบนี้

เริ่มเซิร์ฟเวอร์โดยตรง:

```sh
node server.mjs
```

โปรเซสจะรอ JSON-RPC ทาง stdin ตามปกติ ไม่มีหน้าเว็บหรือพอร์ต HTTP

ใช้ Node ที่มีอยู่และ MCP SDK 1.30.0 จาก `/Users/paranee/projects/MCP_Servers/Safari_Connector/mcp-server` ผ่าน `runtime.mjs` ไม่ได้ติดตั้ง dependency หรือแก้ lockfile ของโปรเจกต์อื่น หากย้ายหรือลบโปรเจกต์ต้นทางนี้ เซิร์ฟเวอร์จะเริ่มไม่ได้จนกว่าจะปรับเส้นทาง dependency

## เครื่องมือ

| Tool | การใช้งาน |
| --- | --- |
| `list_accounts` | รายชื่อบัญชีและ ID โดยไม่อ่านรหัสผ่าน |
| `list_mailboxes` | โฟลเดอร์ลูกหนึ่งระดับ แบ่งหน้า; ใช้ `mailbox_path: []` สำหรับรากบัญชี |
| `list_messages` | รายการเมลแบบแบ่งหน้า สูงสุด 50 รายการต่อครั้ง; ส่ง `since` (ISO 8601) เพื่อหยุดที่เมลเก่ากว่า — งานเมลใหม่ไม่ต้องเดินทั้งกล่อง |
| `bulk_read_messages` | **ใหม่ 0.3.0** อ่านเนื้อหา ≤10 ฉบับ/call (แต่ละฉบับเป็น bridge call คุมจังหวะอิสระ); ใช้กับบัญชีไม่มี API เช่น Hotmail; ล้มฉบับไหนรายงานแล้วข้าม |
| `search_messages` | ค้น subject/sender ในช่วงหน้าที่ระบุ ต้องเรียกหน้าถัดไปจนครบ |
| `read_message` | อ่านเนื้อหา plain text จำกัดความยาว พร้อมสถานะ read ก่อน/หลัง |
| `list_attachments` | รายการไฟล์แนบและสถานะ downloaded; MIME type อาจเป็น null |
| `download_attachment` | ส่งออกไฟล์แนบที่ Mail ดาวน์โหลดแล้ว ลงโฟลเดอร์ใหม่เฉพาะครั้ง |

ใช้ `account_id`, `mailbox_path` และ `message_id` ที่ได้จากเครื่องมือก่อนหน้า ชื่อโฟลเดอร์เป็น array ขององค์ประกอบ ไม่ใช่ path ระบบไฟล์

## ขอบเขตการอ่านอย่างเดียว

ไม่มีคำสั่งส่งเมล ลบ ย้าย เปลี่ยนสถานะอ่าน แก้บัญชี หรือรัน script ตามข้อความที่ผู้เรียกส่งมา ใช้โปรแกรม JXA คงที่ผ่าน `osascript -l JavaScript` บน Apple Events เดียวกับ AppleScript ส่ง arguments เป็น JSON และไม่ใช้ shell interpolation

`download_attachment` เขียนไฟล์ลงดิสก์ จึงตั้ง `readOnlyHint: false` อย่างตรงไปตรงมา แม้ไม่แก้ไขกล่องเมล เครื่องมืออื่นตั้ง readOnlyHint เป็น true ไม่เปิดหรือรันไฟล์แนบ และไม่มีการส่งเนื้อหาไปบริการวิเคราะห์ภายนอกโดยตัวเซิร์ฟเวอร์ อย่างไรก็ตาม client/โมเดลที่เรียก MCP จะได้รับข้อมูลที่อ่านตามคำขอ

ไฟล์ส่งออกอยู่ใน `downloads/attachment-*/` จำกัด 25 MiB ต่อไฟล์ โฟลเดอร์ใหม่ mode 0700 และไฟล์ mode 0600 ปรับชื่อไฟล์ไม่ให้หลุดโฟลเดอร์ ไม่เขียนทับไฟล์เดิม มีไฟล์ตัวอย่างจากการทดสอบจริงหนึ่งรายการอยู่ใน downloads

## ข้อจำกัดของเครื่องมือ Apple Mail เดิม

- เครื่องมือเดิมที่ไม่มี prefix `server_` อ่านเฉพาะสิ่งที่ Apple Mail เปิดให้ scripting เห็น; ใช้กลุ่ม `server_` เมื่อต้องการอ่านจาก Gmail server
- ไม่เปลี่ยน Download Attachments จาก Recent เป็น All และไม่บังคับ sync ทั้งบัญชี
- `download_attachment` เดิมตอบ `ATTACHMENT_NOT_DOWNLOADED` สำหรับไฟล์ที่ไม่มีใน cache; ใช้ `server_download_attachment` กับ Gmail message ID และ part_key สำหรับดาวน์โหลดโดยตรง
- การค้นหาเป็น subject/sender แบบแบ่งหน้า ไม่ใช่ full-text body search หรือดัชนีรวมทุกบัญชี
- ลำดับ/offset อาจเปลี่ยนระหว่าง sync ควร deduplicate ด้วย account ID และ message ID; การสแกนไม่ใช่ snapshot คงที่
- timeout ของ osascript 20 วินาที ไม่มี retry อัตโนมัติ Mail อาจยังประมวลผล Apple Event ที่ส่งไปแล้ว โดยเฉพาะการส่งออกไฟล์ ให้ตรวจโฟลเดอร์ครั้งนั้นก่อนลองใหม่
- ไม่สามารถรับประกันได้ว่าพฤติกรรม cache/sync ภายใน Mail จะไม่มีการเขียนดิสก์; ไม่สั่งเปลี่ยนสถานะเมล และได้ตรวจ unread สองตัวอย่างจริงเท่านั้น
- สิทธิ์ Automation ของแต่ละโปรแกรมที่เปิด server อาจต่างกัน หากขึ้นคำขอใหม่ให้ผู้ใช้ตรวจและอนุญาตเอง ไม่มีการแก้ TCC/Full Disk Access

## ตรวจสอบซ้ำ

```sh
node --test test/core.test.mjs
node test/live.mjs
node --test test/*.test.mjs
node test/server-live.mjs
```

คำสั่ง live อ่านตัวอย่างจริงและส่งออกไฟล์แนบรูปภาพขนาดเล็กได้หนึ่งไฟล์ต่อรอบ พิมพ์เฉพาะจำนวนและสถานะ ไม่พิมพ์เนื้อหาเมล ผลทดสอบ MIME type รอบแรกพบ AppleEvent -10000; แก้ให้คืน null พร้อม `mime_type_available: false` แล้วทดสอบซ้ำผ่าน

`server-live.mjs` อ่านตัวอย่างจากเซิร์ฟเวอร์ ส่งออกไฟล์แนบรูปภาพหนึ่งไฟล์ และสแกนรายการ ID ของ mailbox ทั้งหมดโดยไม่อ่านเนื้อหาทุกฉบับ; พิมพ์เฉพาะจำนวน/สถานะและบันทึก SERVER_VERIFICATION.json ไม่พิมพ์เนื้อหาเมล

แหล่งอ้างอิง: Mail scripting dictionary ใน `/System/Applications/Mail.app/Contents/Resources/Mail.sdef`, SDK ที่ติดตั้งจริง, [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [Gmail messages.list](https://developers.google.com/workspace/gmail/api/guides/list-messages), [Gmail REST API](https://developers.google.com/workspace/gmail/api/reference/rest) และ [Google OAuth refresh](https://developers.google.com/identity/protocols/oauth2/web-server#offline)

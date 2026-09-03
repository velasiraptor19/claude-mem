var __IMPORT_META_URL__ = require("node:url").pathToFileURL(__filename).href;
"use strict";var H=Object.defineProperty;var ge=Object.getOwnPropertyDescriptor;var Ne=Object.getOwnPropertyNames;var he=Object.prototype.hasOwnProperty;var Se=(i,e)=>{for(var s in e)H(i,s,{get:e[s],enumerable:!0})},Re=(i,e,s,t)=>{if(e&&typeof e=="object"||typeof e=="function")for(let n of Ne(e))!he.call(i,n)&&n!==s&&H(i,n,{get:()=>e[n],enumerable:!(t=ge(e,n))||t.enumerable});return i};var fe=i=>Re(H({},"__esModule",{value:!0}),i);var je={};Se(je,{SessionStore:()=>ee});module.exports=fe(je);var Z=require("bun:sqlite"),j=require("crypto");var T=require("path"),M=require("os"),x=require("fs"),te=require("url");var Ie=null;function Oe(i){return(Ie??process.stderr.write.bind(process.stderr))(i)}function X(i){Oe(i)}var Ve=process.platform==="win32";function Ae(i){return i.replace(/^\uFEFF/,"")}function P(i){return JSON.parse(Ae(i))}function Le(){return typeof __dirname<"u"?__dirname:(0,T.dirname)((0,te.fileURLToPath)(__IMPORT_META_URL__))}var Qe=Le();function se(i){return typeof i!="string"||i.length===0?i:i==="~"?(0,M.homedir)():i.startsWith("~/")?(0,T.join)((0,M.homedir)(),i.slice(2)):i}function ye(){if(process.env.CLAUDE_MEM_DATA_DIR)return se(process.env.CLAUDE_MEM_DATA_DIR);let i=(0,T.join)((0,M.homedir)(),".claude-mem"),e=(0,T.join)(i,"settings.json");try{if((0,x.existsSync)(e)){let s=P((0,x.readFileSync)(e,"utf-8")),t=s.env??s;if(t.CLAUDE_MEM_DATA_DIR)return se(t.CLAUDE_MEM_DATA_DIR)}}catch{}return i}var O=ye(),ve=process.env.CLAUDE_CONFIG_DIR||(0,T.join)((0,M.homedir)(),".claude"),ze=(0,T.join)(ve,"plugins","marketplaces","thedotmack"),Ce=(0,T.join)(O,"logs"),Ze=(0,T.join)(O,"settings.json"),ne=(0,T.join)(O,"claude-mem.db"),De=(0,T.join)(O,"observer-sessions"),W=(0,T.basename)(De);function re(i){(0,x.mkdirSync)(i,{recursive:!0})}var q={dataDir:()=>O,workerPid:()=>(0,T.join)(O,"worker.pid"),serverPid:()=>(0,T.join)(O,".server-beta.pid"),serverPort:()=>(0,T.join)(O,".server-beta.port"),serverRuntime:()=>(0,T.join)(O,".server-beta.runtime.json"),settings:()=>(0,T.join)(O,"settings.json"),database:()=>(0,T.join)(O,"claude-mem.db"),chroma:()=>(0,T.join)(O,"chroma"),combinedCerts:()=>(0,T.join)(O,"combined_certs.pem"),transcriptsConfig:()=>(0,T.join)(O,"transcript-watch.json"),transcriptsState:()=>(0,T.join)(O,"transcript-watch-state.json"),corpora:()=>(0,T.join)(O,"corpora"),supervisorRegistry:()=>(0,T.join)(O,"supervisor.json"),envFile:()=>(0,T.join)(O,".env"),logsDir:()=>Ce};var v=require("fs"),oe=require("path");var Y=(r=>(r[r.DEBUG=0]="DEBUG",r[r.INFO=1]="INFO",r[r.WARN=2]="WARN",r[r.ERROR=3]="ERROR",r[r.SILENT=4]="SILENT",r))(Y||{}),V=null,K=class{level=null;useColor;logFilePath=null;logFileInitialized=!1;constructor(){this.useColor=process.stdout.isTTY??!1}ensureLogFileInitialized(){try{let e=q.logsDir();(0,v.existsSync)(e)||(0,v.mkdirSync)(e,{recursive:!0});let s=new Date().toISOString().split("T")[0],t=(0,oe.join)(e,`claude-mem-${s}.log`);if(this.logFileInitialized&&this.logFilePath===t)return;this.logFileInitialized=!0,this.logFilePath=t}catch(e){console.error("[LOGGER] Failed to initialize log file:",e instanceof Error?e.message:String(e)),this.logFilePath=null}}getLevel(){if(this.level===null)try{let e=q.settings();if((0,v.existsSync)(e)){let s=(0,v.readFileSync)(e,"utf-8"),n=(P(s).CLAUDE_MEM_LOG_LEVEL||"INFO").toUpperCase();this.level=Y[n]??1}else this.level=1}catch(e){console.error("[LOGGER] Failed to load log level from settings:",e instanceof Error?e.message:String(e)),this.level=1}return this.level}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;let t=s;if(typeof s=="string")try{t=JSON.parse(s)}catch{t=s}if(e==="Bash"&&t.command)return`${e}(${t.command})`;if(t.file_path)return`${e}(${t.file_path})`;if(t.notebook_path)return`${e}(${t.notebook_path})`;if(e==="Glob"&&t.pattern)return`${e}(${t.pattern})`;if(e==="Grep"&&t.pattern)return`${e}(${t.pattern})`;if(t.url)return`${e}(${t.url})`;if(t.query)return`${e}(${t.query})`;if(e==="Task"){if(t.subagent_type)return`${e}(${t.subagent_type})`;if(t.description)return`${e}(${t.description})`}return e==="Skill"&&t.skill?`${e}(${t.skill})`:e==="LSP"&&t.operation?`${e}(${t.operation})`:e}formatTimestamp(e){let s=e.getFullYear(),t=String(e.getMonth()+1).padStart(2,"0"),n=String(e.getDate()).padStart(2,"0"),r=String(e.getHours()).padStart(2,"0"),o=String(e.getMinutes()).padStart(2,"0"),a=String(e.getSeconds()).padStart(2,"0"),d=String(e.getMilliseconds()).padStart(3,"0");return`${s}-${t}-${n} ${r}:${o}:${a}.${d}`}log(e,s,t,n,r){if(e<this.getLevel())return;this.ensureLogFileInitialized();let o=this.formatTimestamp(new Date),a=Y[e].padEnd(5),d=s.padEnd(6),c="";n?.correlationId?c=`[${n.correlationId}] `:n?.sessionId&&(c=`[session-${n.sessionId}] `);let u="";if(r!=null)if(r instanceof Error)u=this.getLevel()===0?`
${r.message}
${r.stack}`:` ${r.message}`;else if(this.getLevel()===0&&typeof r=="object")try{u=`
`+JSON.stringify(r,null,2)}catch{u=" "+this.formatData(r)}else u=" "+this.formatData(r);let l="";if(n){let{sessionId:f,memorySessionId:A,correlationId:S,...b}=n;Object.keys(b).length>0&&(l=` {${Object.entries(b).map(([N,C])=>`${N}=${C}`).join(", ")}}`)}let E=`[${o}] [${a}] [${d}] ${c}${t}${l}${u}`;if(this.logFilePath)try{(0,v.appendFileSync)(this.logFilePath,E+`
`,"utf8")}catch(f){let A=f instanceof Error?f:new Error(String(f));X(`[LOGGER] Failed to write to log file: ${A.message}
${A.stack??""}
`)}else X(E+`
`)}debug(e,s,t,n){this.log(0,e,s,t,n)}info(e,s,t,n){this.log(1,e,s,t,n)}warn(e,s,t,n){this.log(2,e,s,t,n)}setErrorSink(e){V=e}error(e,s,t,n){this.log(3,e,s,t,n),this.routeErrorToSink(s,t,n)}routeErrorToSink(e,s,t){try{if(!V||!(t instanceof Error))return;V(t)}catch{}}dataIn(e,s,t,n){this.info(e,`\u2192 ${s}`,t,n)}dataOut(e,s,t,n){this.info(e,`\u2190 ${s}`,t,n)}success(e,s,t,n){this.info(e,`\u2713 ${s}`,t,n)}failure(e,s,t,n){this.error(e,`\u2717 ${s}`,t,n)}},_=new K;var ie=["historical_scan","superseded_turn_mismatch"];var ae=require("crypto");function de(i,e,s){return(0,ae.createHash)("sha256").update([i||"",e||"",s||""].join("\0")).digest("hex").slice(0,16)}var p="claude";function Ue(i){return i.trim().toLowerCase().replace(/\s+/g,"-")}function R(i){if(!i)return p;let e=Ue(i);return e?e==="transcript"||e.includes("codex")?"codex":e.includes("cursor")?"cursor":e.includes("claude")?"claude":e:p}function _e(i){let e=["claude","codex","cursor"];return[...i].sort((s,t)=>{let n=e.indexOf(s),r=e.indexOf(t);return n!==-1||r!==-1?n===-1?1:r===-1?-1:n-r:s.localeCompare(t)})}function ce(i,e,s,t,n){let r=Date.now()-t,o=n!==void 0?"up.session_db_id = ?":"up.content_session_id = ?",a=n??e;return i.prepare(`
    SELECT
      up.*,
      s.memory_session_id,
      s.project,
      COALESCE(s.platform_source, '${p}') as platform_source
    FROM user_prompts up
    JOIN sdk_sessions s ON up.session_db_id = s.id
    WHERE ${o}
      AND up.prompt_text = ?
      AND up.created_at_epoch >= ?
    ORDER BY up.created_at_epoch DESC
    LIMIT 1
  `).get(a,s,r)??void 0}var le=["private","claude-mem-context","system_instruction","system-instruction","persisted-output","system-reminder"],ue=new RegExp(`<(${le.join("|")})\\b[^>]*>[\\s\\S]*?</\\1>`,"g");var pe=100;function xe(i){let e=Object.fromEntries(le.map(n=>[n,0]));ue.lastIndex=0;let s=0,t=i.replace(ue,(n,r)=>(e[r]=(e[r]??0)+1,s+=1,""));return s>pe&&_.warn("SYSTEM","tag count exceeds limit",void 0,{tagCount:s,maxAllowed:pe,contentLength:i.length}),{stripped:t.trim(),counts:e}}function Ee(i){return xe(i).stripped}var we=["task-notification"],us=new RegExp(`^\\s*<(${we.join("|")})\\b[^>]*>(?:(?!<\\1\\b|</\\1\\b)[\\s\\S])*</\\1>\\s*$`),ps=256*1024;var J=4e3;function G(i){let e=i.trim(),t=Ee(i).trim()||e;return t.length<=J?t:(_.debug("DB","Truncated stored prompt text to the configured cap",{originalLength:t.length,storedLength:J}),`${t.slice(0,J-1)}\u2026`)}var Me=require("bun:sqlite");var Fe=5e3,ke=4194304;function Xe(i){return i.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    LIMIT 1
  `).get()!=null}function w(i,e,s){try{i.run(e)}catch(t){let n=t instanceof Error?t:new Error(String(t));throw _.warn("DB",`Failed to apply SQLite pragma ${s}`,{sql:e},n),t}}function me(i,e={}){let{enableWal:s=!0,enableIncrementalAutoVacuum:t=!0}=e;w(i,`PRAGMA busy_timeout = ${Fe}`,"busy_timeout"),w(i,"PRAGMA foreign_keys = ON","foreign_keys"),w(i,"PRAGMA synchronous = NORMAL","synchronous"),w(i,`PRAGMA journal_size_limit = ${ke}`,"journal_size_limit"),t&&!Xe(i)&&w(i,"PRAGMA auto_vacuum = INCREMENTAL","auto_vacuum"),s&&w(i,"PRAGMA journal_mode = WAL","journal_mode")}var Te=4096;var Pe=new Set(["set_title","set_prompt_session","remap_project"]),Ge=/^(?:0|[1-9][0-9]*)$/,be=18446744073709551615n;function y(i){throw _.debug("CLOUD_SYNC","Rejected invalid canonical content",{reason:i}),new Error(`canonical content: ${i}`)}function $(i,e={}){return typeof i!="string"||!Ge.test(i)?y("decimal values must be unsigned base-10 strings without leading zeroes"):(BigInt(i)>be&&y("decimal value exceeds uint64"),e.positive&&i==="0"&&y("decimal value must be positive"),i)}function Q(i){let e=$(i);return BigInt(e)===be&&y("uint64 sequence overflow"),(BigInt(e)+1n).toString(10)}function Be(i){(i===null||typeof i!="object"||Array.isArray(i))&&y("mutation must be an object");let e=i;if((typeof e.op!="string"||!Pe.has(e.op))&&y("unsupported mutation op"),e.op==="set_title"){let r=F(e,["fields","op","target"],"set_title"),o=B(r.target,["content_session_id","memory_session_id","platform_source"],"set_title.target");o.memory_session_id===void 0&&o.content_session_id===void 0&&y("set_title target requires a session identifier");for(let d of["memory_session_id","content_session_id","platform_source"])o[d]!==void 0&&D(o[d],d);let a=F(r.fields,["custom_title"],"set_title.fields");D(a.custom_title,"custom_title");return}if(e.op==="set_prompt_session"){let r=F(e,["fields","op","target"],"set_prompt_session"),o=F(r.target,["origin_device_id","origin_local_id"],"set_prompt_session.target");$e(o.origin_device_id),$(o.origin_local_id);let a=B(r.fields,["content_session_id","memory_session_id","platform_source","project"],"set_prompt_session.fields");D(a.memory_session_id,"memory_session_id");for(let d of["content_session_id","platform_source","project"])a[d]!==void 0&&D(a[d],d);return}let s=F(e,["fields","op","where"],"remap_project"),t=B(s.where,["memory_session_id","merged_into_project_is_null","project"],"remap_project.where");t.project!==void 0&&D(t.project,"project"),t.memory_session_id!==void 0&&D(t.memory_session_id,"memory_session_id"),t.merged_into_project_is_null!==void 0&&t.merged_into_project_is_null!==!0&&y("merged_into_project_is_null may only be true"),Object.keys(t).length===0&&y("remap_project where is empty");let n=B(s.fields,["merged_into_project","project"],"remap_project.fields");n.project!==void 0&&D(n.project,"project"),n.merged_into_project!==void 0&&D(n.merged_into_project,"merged_into_project"),Object.keys(n).length===0&&y("remap_project fields are empty")}function z(i){Be(i)}function $e(i){return typeof i!="string"||i.length===0||Buffer.byteLength(i,"utf8")>128?y("origin_device_id must be a non-empty string of at most 128 UTF-8 bytes"):i}function D(i,e){return typeof i!="string"||i.length===0||i.trim().length===0||Buffer.byteLength(i,"utf8")>Te?y(`${e} must be a non-blank string of at most ${Te} UTF-8 bytes`):i}function F(i,e,s){if(i===null||typeof i!="object"||Array.isArray(i))return y(`${s} must be an object`);let t=i,n=Object.keys(t).sort(),r=[...e].sort();return(n.length!==r.length||n.some((o,a)=>o!==r[a]))&&y(`${s} must contain exactly: ${r.join(", ")}`),t}function B(i,e,s){if(i===null||typeof i!="object"||Array.isArray(i))return y(`${s} must be an object`);let t=i,n=new Set(e),r=Object.keys(t).find(o=>!n.has(o));return r&&y(`${s} contains unknown field ${r}`),t}var U=`(cancellation_reason IS NULL OR cancellation_reason IN (${ie.map(i=>`'${i}'`).join(", ")}))`,ee=class{db;constructor(e=ne){e instanceof Z.Database?this.db=e:(e!==":memory:"&&re(O),this.db=new Z.Database(e)),me(this.db),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.renameSessionIdColumns(),this.addFailedAtEpochColumn(),this.addOnUpdateCascadeToForeignKeys(),this.addObservationContentHashColumn(),this.addSessionCustomTitleColumn(),this.addSessionPlatformSourceColumn(),this.addObservationModelColumns(),this.ensureMergedIntoProjectColumns(),this.addObservationSubagentColumns(),this.addObservationsUniqueContentHashIndex(),this.addObservationsMetadataColumn(),this.dropDeadPendingMessagesColumns(),this.ensurePendingMessagesToolUseIdColumn(),this.dropWorkerPidColumn(),this.ensureSDKSessionsPlatformContentIdentity(),this.ensureUserPromptsSessionDbId(),this.ensurePendingMessagesSessionToolUniqueIndex(),this.ensureSyncedAtColumns(),this.ensureSyncOriginColumns(),this.ensureSyncOutbox(),this.ensureSyncEntityLedger(),this.ensureSyncRevisionTextAffinity(),this.initializeSyncHubLaunchBaseline(),this.normalizeConceptTags(),this.createRecoveryJobsTable(),this.ensureRecoveryLineageSchema(),this.ensureHistoricalSummaryRepresentations(),this.ensureRecoveryCancellationProvenance()}ensureRecoveryCancellationProvenance(){this.db.run("BEGIN IMMEDIATE");try{this.db.query("PRAGMA table_info(recovery_jobs)").all().some(s=>s.name==="cancellation_reason")||this.db.run("ALTER TABLE recovery_jobs ADD COLUMN cancellation_reason TEXT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(53,new Date().toISOString()),this.db.run("COMMIT")}catch(e){try{this.db.run("ROLLBACK")}catch{}throw e}}ensureHistoricalSummaryRepresentations(){if(this.db.prepare("SELECT 1 FROM schema_versions WHERE version = 52").get())return;this.db.transaction(()=>{this.db.run(`CREATE TABLE IF NOT EXISTS historical_summary_representations (
        source_fingerprint TEXT PRIMARY KEY,
        summary_id INTEGER NOT NULL REFERENCES session_summaries(id) ON DELETE CASCADE,
        representation_kind TEXT NOT NULL CHECK(representation_kind IN ('original','backfill_part','backfill_merged')),
        content_session_id TEXT NOT NULL,
        prompt_number INTEGER NOT NULL,
        created_at_epoch INTEGER NOT NULL
      )`),this.db.run("CREATE INDEX IF NOT EXISTS idx_historical_representations_turn ON historical_summary_representations(content_session_id, prompt_number)"),this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(52,new Date().toISOString())})()}ensureRecoveryLineageSchema(){let e=this.db.prepare("SELECT 1 FROM schema_versions WHERE version = 51").get();if(this.db.run(`
      DROP INDEX IF EXISTS ux_recovery_jobs_active_session_kind;
      CREATE INDEX IF NOT EXISTS idx_recovery_jobs_active_session_kind
        ON recovery_jobs(content_session_id, recovery_kind, status);
    `),e)return;let s=(r,o,a)=>{this.db.query(`PRAGMA table_info(${r})`).all().some(c=>c.name===o)||this.db.run(`ALTER TABLE ${r} ADD COLUMN ${o} ${a}`)},t=[["parent_content_session_id","TEXT"],["root_content_session_id","TEXT"],["agent_id","TEXT"],["agent_type","TEXT"],["agent_path","TEXT"],["agent_nickname","TEXT"],["agent_depth","INTEGER"],["transcript_locator","TEXT"]];this.db.transaction(()=>{for(let[o,a]of t)s("sdk_sessions",o,a);let r=[["recovery_key","TEXT"],["source_fingerprint","TEXT"],["prompt_number","INTEGER"],["turn_id","TEXT"],["parent_content_session_id","TEXT"],["root_content_session_id","TEXT"],["agent_id","TEXT"],["transcript_sha256","TEXT"],["dead_letter_reason","TEXT"]];for(let[o,a]of r)s("recovery_jobs",o,a);s("session_summaries","source_fingerprint","TEXT"),this.db.run(`
      UPDATE recovery_jobs SET recovery_key = 'legacy:' || id WHERE recovery_key IS NULL;
      DROP INDEX IF EXISTS ux_recovery_jobs_active_session_kind;
      CREATE UNIQUE INDEX IF NOT EXISTS ux_recovery_jobs_key ON recovery_jobs(recovery_key);
      CREATE INDEX IF NOT EXISTS idx_recovery_jobs_active_session_kind
        ON recovery_jobs(content_session_id, recovery_kind, status);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_session_summaries_source_fingerprint
        ON session_summaries(source_fingerprint) WHERE source_fingerprint IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_parent ON sdk_sessions(parent_content_session_id);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_root ON sdk_sessions(root_content_session_id);
    `),this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(51,new Date().toISOString())})()}createRecoveryJobsTable(){this.db.run(`
      CREATE TABLE IF NOT EXISTS recovery_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT NOT NULL,
        recovery_kind TEXT NOT NULL,
        project TEXT NOT NULL,
        platform_source TEXT NOT NULL,
        transcript_locator TEXT,
        reason TEXT NOT NULL,
        first_failure_at_epoch INTEGER NOT NULL,
        last_failure_at_epoch INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        next_attempt_at_epoch INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'running', 'retry_wait', 'completed', 'dead_letter', 'cancelled')),
        provider TEXT,
        model TEXT,
        last_sanitized_error TEXT,
        lease_owner TEXT,
        lease_expires_at_epoch INTEGER,
        created_at_epoch INTEGER NOT NULL,
        updated_at_epoch INTEGER NOT NULL,
        completed_at_epoch INTEGER,
        cancellation_reason TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_recovery_jobs_active_session_kind
      ON recovery_jobs(content_session_id, recovery_kind)
      WHERE status IN ('pending', 'running', 'retry_wait');

      CREATE INDEX IF NOT EXISTS idx_recovery_jobs_claim
      ON recovery_jobs(status, next_attempt_at_epoch, created_at_epoch, id);

      CREATE INDEX IF NOT EXISTS idx_recovery_jobs_lease
      ON recovery_jobs(status, lease_expires_at_epoch)
      WHERE status = 'running';
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(50,new Date().toISOString())}getIndexColumns(e){return this.db.query(`PRAGMA index_info(${JSON.stringify(e)})`).all().map(s=>s.name)}hasUniqueIndexOnColumns(e,s){return this.db.query(`PRAGMA index_list(${e})`).all().some(n=>{if(n.unique!==1)return!1;let r=this.getIndexColumns(n.name);return r.length===s.length&&r.every((o,a)=>o===s[a])})}resolvePromptSessionDbId(e,s,t){if(s!==void 0)return s;let n=t?R(t):void 0;return n?this.db.prepare(`
        SELECT id
        FROM sdk_sessions
        WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
          AND content_session_id = ?
        LIMIT 1
      `).get(p,n,e)?.id??null:this.db.prepare(`
      SELECT id
      FROM sdk_sessions
      WHERE content_session_id = ?
      ORDER BY CASE COALESCE(NULLIF(platform_source, ''), '${p}')
        WHEN '${p}' THEN 0
        ELSE 1
      END, id
      LIMIT 1
    `).get(e)?.id??null}dropWorkerPidColumn(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(32),t=this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="worker_pid");if(!(e&&!t)){if(t)try{this.db.run("DROP INDEX IF EXISTS idx_pending_messages_worker_pid"),this.db.run("ALTER TABLE pending_messages DROP COLUMN worker_pid"),_.debug("DB","Dropped worker_pid column and its index from pending_messages")}catch(n){_.warn("DB","Failed to drop worker_pid column from pending_messages",{},n instanceof Error?n:new Error(String(n)));return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(32,new Date().toISOString())}}ensureSDKSessionsPlatformContentIdentity(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(33),s=this.hasUniqueIndexOnColumns("sdk_sessions",["content_session_id"]),t=this.hasUniqueIndexOnColumns("sdk_sessions",["platform_source","content_session_id"]),r=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(o=>o.name==="platform_source");if(!(e&&!s&&t&&r)){if(r||this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${p}'`),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${p}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),s){this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");try{this.rebuildSdkSessionsWithCompositeIdentity(e),this.db.run("COMMIT")}catch(o){this.db.run("ROLLBACK");let a=o instanceof Error?o:new Error(String(o));throw _.error("DB","Failed to rebuild sdk_sessions with composite identity, rolled back",{},a),o}finally{this.db.run("PRAGMA foreign_keys = ON")}return}this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(33,new Date().toISOString())}}rebuildSdkSessionsWithCompositeIdentity(e){this.db.run("DROP TABLE IF EXISTS sdk_sessions_new"),this.db.run(`
      CREATE TABLE sdk_sessions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT NOT NULL,
        memory_session_id TEXT UNIQUE,
        project TEXT NOT NULL,
        platform_source TEXT NOT NULL DEFAULT '${p}',
        user_prompt TEXT,
        started_at TEXT NOT NULL,
        started_at_epoch INTEGER NOT NULL,
        completed_at TEXT,
        completed_at_epoch INTEGER,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'failed')),
        worker_port INTEGER,
        prompt_counter INTEGER DEFAULT 0,
        custom_title TEXT
      )
    `),this.db.run(`
      INSERT INTO sdk_sessions_new (
        id, content_session_id, memory_session_id, project, platform_source,
        user_prompt, started_at, started_at_epoch, completed_at, completed_at_epoch,
        status, worker_port, prompt_counter, custom_title
      )
      SELECT
        id, content_session_id, memory_session_id, project,
        COALESCE(NULLIF(platform_source, ''), '${p}'),
        user_prompt, started_at, started_at_epoch, completed_at, completed_at_epoch,
        status, worker_port, prompt_counter, custom_title
      FROM sdk_sessions
    `),this.db.run("DROP TABLE sdk_sessions"),this.db.run("ALTER TABLE sdk_sessions_new RENAME TO sdk_sessions"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(33,new Date().toISOString())}ensureUserPromptsSessionDbId(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(34);if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='user_prompts'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34,new Date().toISOString());return}let n=this.db.query("PRAGMA table_info(user_prompts)").all().some(c=>c.name==="session_db_id"),o=this.db.query("PRAGMA foreign_key_list(user_prompts)").all().some(c=>c.table==="sdk_sessions"&&c.from==="content_session_id");if(e&&n&&!o)return;let a=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_prompts_fts'").all().length>0,d=n?`COALESCE(up.session_db_id, (
          SELECT s.id FROM sdk_sessions s
          WHERE s.content_session_id = up.content_session_id
          ORDER BY CASE COALESCE(NULLIF(s.platform_source, ''), '${p}')
            WHEN '${p}' THEN 0
            ELSE 1
          END, s.id
          LIMIT 1
        ))`:`(
          SELECT s.id FROM sdk_sessions s
          WHERE s.content_session_id = up.content_session_id
          ORDER BY CASE COALESCE(NULLIF(s.platform_source, ''), '${p}')
            WHEN '${p}' THEN 0
            ELSE 1
          END, s.id
          LIMIT 1
        )`;this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");try{this.rebuildUserPromptsWithSessionDbId(e,d,a),this.db.run("COMMIT")}catch(c){this.db.run("ROLLBACK");let u=c instanceof Error?c:new Error(String(c));throw _.error("DB","Failed to rebuild user_prompts with session_db_id, rolled back",{},u),c}finally{this.db.run("PRAGMA foreign_keys = ON")}}rebuildUserPromptsWithSessionDbId(e,s,t){this.db.run("DROP TRIGGER IF EXISTS user_prompts_ai"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_ad"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_au"),this.db.run("DROP TABLE IF EXISTS user_prompts_new"),this.db.run(`
      CREATE TABLE user_prompts_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER,
        content_session_id TEXT NOT NULL,
        prompt_number INTEGER NOT NULL,
        prompt_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `),this.db.run(`
      INSERT INTO user_prompts_new (
        id, session_db_id, content_session_id, prompt_number,
        prompt_text, created_at, created_at_epoch
      )
      SELECT
        up.id,
        ${s},
        up.content_session_id,
        up.prompt_number,
        up.prompt_text,
        up.created_at,
        up.created_at_epoch
      FROM user_prompts up
    `),this.db.run("DROP TABLE user_prompts"),this.db.run("ALTER TABLE user_prompts_new RENAME TO user_prompts"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_claude_session ON user_prompts(content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_created ON user_prompts(created_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_prompt_number ON user_prompts(prompt_number)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_lookup ON user_prompts(session_db_id, prompt_number)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_content_lookup ON user_prompts(content_session_id, prompt_number)"),t&&(this.db.run(`
        CREATE TRIGGER user_prompts_ai AFTER INSERT ON user_prompts BEGIN
          INSERT INTO user_prompts_fts(rowid, prompt_text)
          VALUES (new.id, new.prompt_text);
        END;

        CREATE TRIGGER user_prompts_ad AFTER DELETE ON user_prompts BEGIN
          INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
          VALUES('delete', old.id, old.prompt_text);
        END;

        CREATE TRIGGER user_prompts_au AFTER UPDATE ON user_prompts BEGIN
          INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
          VALUES('delete', old.id, old.prompt_text);
          INSERT INTO user_prompts_fts(rowid, prompt_text)
          VALUES (new.id, new.prompt_text);
        END;
      `),this.db.run("INSERT INTO user_prompts_fts(user_prompts_fts) VALUES('rebuild')")),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34,new Date().toISOString())}ensurePendingMessagesSessionToolUniqueIndex(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(35);if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(35,new Date().toISOString());return}let t=this.hasUniqueIndexOnColumns("pending_messages",["session_db_id","tool_use_id"]);if(!(e&&t)){this.db.run("BEGIN TRANSACTION");try{this.recreatePendingSessionToolUniqueIndex(e),this.db.run("COMMIT")}catch(n){this.db.run("ROLLBACK");let r=n instanceof Error?n:new Error(String(n));throw _.error("DB","Failed to recreate ux_pending_session_tool index, rolled back",{},r),n}}}recreatePendingSessionToolUniqueIndex(e){this.db.run("DROP INDEX IF EXISTS ux_pending_session_tool"),this.db.run(`
      DELETE FROM pending_messages
       WHERE id IN (
         SELECT id
           FROM (
             SELECT id,
                    ROW_NUMBER() OVER (
                      PARTITION BY session_db_id, tool_use_id
                      ORDER BY CASE status
                        WHEN 'processing' THEN 0
                        WHEN 'pending' THEN 1
                        ELSE 2
                      END, id
                    ) AS duplicate_rank
               FROM pending_messages
              WHERE tool_use_id IS NOT NULL
           )
          WHERE duplicate_rank > 1
         )
    `),this.db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_session_tool
      ON pending_messages(session_db_id, tool_use_id)
      WHERE tool_use_id IS NOT NULL
    `),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(35,new Date().toISOString())}ensureSyncedAtColumns(){for(let e of["observations","session_summaries","user_prompts"])this.db.query(`PRAGMA table_info(${e})`).all().some(n=>n.name==="synced_at")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN synced_at INTEGER`),_.debug("DB",`Added synced_at column to ${e} table`)),this.db.run(`CREATE INDEX IF NOT EXISTS idx_${e}_unsynced ON ${e}(id) WHERE synced_at IS NULL`);this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(39,new Date().toISOString())}ensureSyncOriginColumns(){for(let e of["observations","session_summaries","user_prompts"]){let s=this.db.query(`PRAGMA table_info(${e})`).all(),t=new Set(s.map(n=>n.name));t.has("origin_device_id")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN origin_device_id TEXT`),_.debug("DB",`Added origin_device_id column to ${e} table`)),t.has("origin_local_id")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN origin_local_id TEXT`),_.debug("DB",`Added origin_local_id column to ${e} table`)),t.has("sync_rev")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN sync_rev TEXT NOT NULL DEFAULT '1'`),_.debug("DB",`Added sync_rev column to ${e} table`)),this.db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS ux_${e}_origin
        ON ${e}(origin_device_id, origin_local_id)
        WHERE origin_device_id IS NOT NULL
      `)}this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_state (
        k TEXT PRIMARY KEY,
        v TEXT
      )
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(41,new Date().toISOString())}ensureSyncOutbox(){this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        op_uuid TEXT NOT NULL UNIQUE,
        rev TEXT NOT NULL DEFAULT '1',
        body TEXT NOT NULL,
        canonical_body TEXT,
        operation_sha256 TEXT,
        created_at_epoch INTEGER NOT NULL
      )
    `);let e=new Set(this.db.query("PRAGMA table_info(sync_outbox)").all().map(s=>s.name));e.has("canonical_body")||this.db.run("ALTER TABLE sync_outbox ADD COLUMN canonical_body TEXT"),e.has("operation_sha256")||this.db.run("ALTER TABLE sync_outbox ADD COLUMN operation_sha256 TEXT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(42,new Date().toISOString())}ensureSyncRevisionTextAffinity(){let e=[{table:"observations",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"session_summaries",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"user_prompts",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"sync_outbox",column:"rev",temporary:"rev_text_v46"}],s=(o,a)=>this.db.query(`PRAGMA table_info(${o})`).all().find(d=>d.name===a),t=o=>o?.type.trim().toUpperCase()==="TEXT";if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(46)&&e.every(o=>t(s(o.table,o.column))))return;this.db.transaction(()=>{for(let o of e){let a=this.db.query(`PRAGMA table_info(${o.table})`).all(),d=a.find(u=>u.name===o.column);if(!d)throw new Error(`schema v46: missing ${o.table}.${o.column}`);for(let u of this.db.query(`
          SELECT CAST(id AS TEXT) AS row_id,
                 typeof(${o.column}) AS storage_type,
                 CAST(${o.column} AS TEXT) AS revision
          FROM ${o.table}
        `).iterate()){let l=u;if(l.storage_type==="real")throw new Error(`schema v46: ${o.table}.${o.column} row ${l.row_id} is REAL and unrecoverably rounded`);if(l.storage_type!=="integer"&&l.storage_type!=="text")throw new Error(`schema v46: ${o.table}.${o.column} row ${l.row_id} has unsupported ${l.storage_type} storage`);try{$(l.revision,{positive:!0})}catch{throw new Error(`schema v46: ${o.table}.${o.column} row ${l.row_id} is not a positive canonical uint64 revision`)}}if(t(d))continue;if(a.some(u=>u.name===o.temporary))throw new Error(`schema v46: unexpected temporary column ${o.table}.${o.temporary}`);this.db.run(`ALTER TABLE ${o.table} ADD COLUMN ${o.temporary} TEXT NOT NULL DEFAULT '1'`),this.db.run(`UPDATE ${o.table} SET ${o.temporary} = CAST(${o.column} AS TEXT)`);let c=this.db.prepare(`
          SELECT CAST(id AS TEXT) AS row_id
          FROM ${o.table}
          WHERE ${o.temporary} <> CAST(${o.column} AS TEXT)
          LIMIT 1
        `).get();if(c)throw new Error(`schema v46: failed to copy ${o.table}.${o.column} row ${c.row_id} exactly`);this.db.run(`ALTER TABLE ${o.table} DROP COLUMN ${o.column}`),this.db.run(`ALTER TABLE ${o.table} RENAME COLUMN ${o.temporary} TO ${o.column}`)}this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(46,new Date().toISOString())})()}ensureSyncEntityLedger(){this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_entity_heads (
        entity_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('observation', 'summary', 'prompt')),
        origin_device_id TEXT NOT NULL,
        origin_local_id TEXT NOT NULL,
        entity_rev TEXT NOT NULL,
        operation_sha256 TEXT NOT NULL,
        deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
        updated_at_epoch INTEGER NOT NULL
      )
    `),this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_content_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('observation', 'summary', 'prompt')),
        origin_local_id TEXT NOT NULL,
        entity_rev TEXT NOT NULL,
        body TEXT NOT NULL,
        operation_sha256 TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
        created_at_epoch INTEGER NOT NULL,
        UNIQUE(entity_id, entity_rev)
      )
    `),new Set(this.db.query("PRAGMA table_info(sync_content_outbox)").all().map(s=>s.name)).has("deleted")||(this.db.run("ALTER TABLE sync_content_outbox ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0"),this.db.run(`
        UPDATE sync_content_outbox
        SET deleted = CASE WHEN json_extract(body, '$.deleted') = 1 THEN 1 ELSE 0 END
      `)),this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_dead_letter (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lane TEXT NOT NULL CHECK (lane IN ('content', 'mutation')),
        queue_key TEXT NOT NULL,
        kind TEXT,
        origin_local_id TEXT,
        entity_rev TEXT,
        reason TEXT NOT NULL,
        raw_body TEXT,
        created_at_epoch INTEGER NOT NULL,
        UNIQUE(lane, queue_key, entity_rev, reason)
      )
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(44,new Date().toISOString()),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(45,new Date().toISOString())}initializeSyncHubLaunchBaseline(){let e=[{table:"observations",kind:"observation"},{table:"session_summaries",kind:"summary"},{table:"user_prompts",kind:"prompt"}],s=this.db.prepare(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type = 'table' AND name = 'sync_launch_exclusions'
    `).get()!==void 0;this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_launch_exclusions (
        kind TEXT NOT NULL CHECK (kind IN ('observation', 'summary', 'prompt')),
        origin_local_id TEXT NOT NULL,
        through_rev TEXT NOT NULL,
        PRIMARY KEY (kind, origin_local_id)
      )
    `);let t=this.db.prepare("SELECT version, applied_at FROM schema_versions WHERE version = ?").get(47);if(!t){let a=Date.now();this.db.transaction(()=>{this.db.run("DELETE FROM sync_launch_exclusions");for(let{table:u,kind:l}of e)this.db.prepare(`
            INSERT INTO sync_launch_exclusions (kind, origin_local_id, through_rev)
            SELECT ?, CAST(id AS TEXT), CAST(sync_rev AS TEXT)
            FROM ${u}
            WHERE origin_device_id IS NULL
          `).run(l),this.db.prepare(`
            UPDATE ${u} SET synced_at = ?
            WHERE synced_at IS NULL AND origin_device_id IS NULL
          `).run(a);this.db.run("DELETE FROM sync_outbox"),this.db.run("DELETE FROM sync_content_outbox"),this.db.run("DELETE FROM sync_dead_letter"),this.db.run("DELETE FROM sync_state");let c=new Date(a).toISOString();this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(47,c),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(48,c)})();return}if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(48)&&s)return;let r=Date.parse(t.applied_at);if(!Number.isSafeInteger(r)||r<0)throw new Error(`schema v48: invalid v47 applied_at ${t.applied_at}`);this.db.transaction(()=>{for(let{table:a,kind:d}of e)this.db.prepare(`
          INSERT OR IGNORE INTO sync_launch_exclusions (kind, origin_local_id, through_rev)
          SELECT ?, CAST(id AS TEXT), CAST(sync_rev AS TEXT)
          FROM ${a}
          WHERE origin_device_id IS NULL
            AND synced_at > 0
            AND synced_at <= ?
        `).run(d,r);this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(48,new Date().toISOString())})()}normalizeConceptTags(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(49))return;let s=0;this.db.transaction(()=>{let n=this.db.prepare(`
        SELECT CAST(id AS TEXT) AS id, origin_device_id, CAST(sync_rev AS TEXT) AS sync_rev
        FROM observations
        WHERE concepts LIKE '%:%' AND json_valid(concepts)
      `).all();s=n.length,this.db.run(`
        UPDATE observations
        SET concepts = (
          SELECT json_group_array(
            CASE WHEN instr(value, ':') > 0
                 THEN trim(substr(value, 1, instr(value, ':') - 1))
                 ELSE value END)
          FROM json_each(observations.concepts))
        WHERE concepts LIKE '%:%' AND json_valid(concepts)
      `);for(let r of n){if(r.origin_device_id!==null)continue;let o=Q(r.sync_rev);this.db.prepare(`
          UPDATE observations SET sync_rev = ?, synced_at = NULL
          WHERE id = ? AND origin_device_id IS NULL
        `).run(o,r.id)}this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(49,new Date().toISOString())})(),_.debug("DB",`Normalized prefixed concept tags in ${s} observations (v49)`)}dropDeadPendingMessagesColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(31),s=this.db.query("PRAGMA table_info(pending_messages)").all(),t=new Set(s.map(o=>o.name)),r=["retry_count","failed_at_epoch","completed_at_epoch"].filter(o=>t.has(o));if(!(e&&r.length===0)){if(r.length>0){this.db.run("BEGIN TRANSACTION");try{this.db.run("DELETE FROM pending_messages WHERE status NOT IN ('pending', 'processing')");for(let o of r)this.db.run(`ALTER TABLE pending_messages DROP COLUMN ${o}`),_.debug("DB",`Dropped dead column ${o} from pending_messages`);e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString()),this.db.run("COMMIT")}catch(o){this.db.run("ROLLBACK"),_.warn("DB","Failed to drop dead columns from pending_messages",{},o instanceof Error?o:new Error(String(o)));return}return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString())}}initializeSchema(){this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `),this.db.run(`
      CREATE TABLE IF NOT EXISTS sdk_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT NOT NULL,
        memory_session_id TEXT UNIQUE,
        project TEXT NOT NULL,
        platform_source TEXT NOT NULL DEFAULT 'claude',
        user_prompt TEXT,
        started_at TEXT NOT NULL,
        started_at_epoch INTEGER NOT NULL,
        completed_at TEXT,
        completed_at_epoch INTEGER,
        status TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active'
      );

      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC);

      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project);
      CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
      CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch DESC);

      CREATE TABLE IF NOT EXISTS session_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT UNIQUE NOT NULL,
        project TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read TEXT,
        files_edited TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString())}ensureWorkerPortColumn(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(t=>t.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),_.debug("DB","Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}ensurePromptTrackingColumns(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(a=>a.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),_.debug("DB","Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),_.debug("DB","Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),_.debug("DB","Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}repairOrphanedSessionParents(e){let s=this.db.prepare(`
      SELECT COUNT(DISTINCT c.memory_session_id) AS n
      FROM ${e} c
      WHERE c.memory_session_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM sdk_sessions s WHERE s.memory_session_id = c.memory_session_id)
    `).get().n;s!==0&&(this.db.run(`
      INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      SELECT
        c.memory_session_id,
        c.memory_session_id,
        MIN(c.project),
        MIN(c.created_at),
        MIN(c.created_at_epoch),
        'completed'
      FROM ${e} c
      WHERE c.memory_session_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM sdk_sessions s WHERE s.memory_session_id = c.memory_session_id)
      GROUP BY c.memory_session_id
      ON CONFLICT DO NOTHING
    `),_.warn("DB",`Created ${s} stub sdk_sessions parent(s) for orphaned ${e} rows before rebuild (#3378)`))}removeSessionSummariesUniqueConstraint(){if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(t=>t.unique===1&&t.origin==="u")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}_.debug("DB","Removing UNIQUE constraint from session_summaries.memory_session_id"),this.db.run("BEGIN TRANSACTION"),this.repairOrphanedSessionParents("session_summaries"),this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.db.run(`
      CREATE TABLE session_summaries_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read TEXT,
        files_edited TEXT,
        notes TEXT,
        prompt_number INTEGER,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
      )
    `),this.db.run(`
      INSERT INTO session_summaries_new
      SELECT id, memory_session_id, project, request, investigated, learned,
             completed, next_steps, files_read, files_edited, notes,
             prompt_number, created_at, created_at_epoch
      FROM session_summaries
    `),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),_.debug("DB","Successfully removed UNIQUE constraint from session_summaries.memory_session_id")}addObservationHierarchicalFields(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.query("PRAGMA table_info(observations)").all().some(n=>n.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}_.debug("DB","Adding hierarchical fields to observations table"),this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),_.debug("DB","Successfully added hierarchical fields to observations table")}makeObservationsTextNullable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let t=this.db.query("PRAGMA table_info(observations)").all().find(n=>n.name==="text");if(!t||t.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}_.debug("DB","Making observations.text nullable"),this.db.run("BEGIN TRANSACTION"),this.repairOrphanedSessionParents("observations"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.db.run(`
      CREATE TABLE observations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT,
        type TEXT NOT NULL,
        title TEXT,
        subtitle TEXT,
        facts TEXT,
        narrative TEXT,
        concepts TEXT,
        files_read TEXT,
        files_modified TEXT,
        prompt_number INTEGER,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
      )
    `),this.db.run(`
      INSERT INTO observations_new
      SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
             narrative, concepts, files_read, files_modified, prompt_number,
             created_at, created_at_epoch
      FROM observations
    `),this.db.run("DROP TABLE observations"),this.db.run("ALTER TABLE observations_new RENAME TO observations"),this.db.run(`
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),_.debug("DB","Successfully made observations.text nullable")}createUserPromptsTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.query("PRAGMA table_info(user_prompts)").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}_.debug("DB","Creating user_prompts table with FTS5 support"),this.db.run("BEGIN TRANSACTION"),this.db.run(`
      CREATE TABLE user_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER,
        content_session_id TEXT NOT NULL,
        prompt_number INTEGER NOT NULL,
        prompt_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_user_prompts_session ON user_prompts(session_db_id);
      CREATE INDEX idx_user_prompts_claude_session ON user_prompts(content_session_id);
      CREATE INDEX idx_user_prompts_created ON user_prompts(created_at_epoch DESC);
      CREATE INDEX idx_user_prompts_prompt_number ON user_prompts(prompt_number);
      CREATE INDEX idx_user_prompts_lookup ON user_prompts(session_db_id, prompt_number);
      CREATE INDEX idx_user_prompts_content_lookup ON user_prompts(content_session_id, prompt_number);
    `);let t=`
      CREATE VIRTUAL TABLE user_prompts_fts USING fts5(
        prompt_text,
        content='user_prompts',
        content_rowid='id'
      );
    `,n=`
      CREATE TRIGGER user_prompts_ai AFTER INSERT ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(rowid, prompt_text)
        VALUES (new.id, new.prompt_text);
      END;

      CREATE TRIGGER user_prompts_ad AFTER DELETE ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
        VALUES('delete', old.id, old.prompt_text);
      END;

      CREATE TRIGGER user_prompts_au AFTER UPDATE ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
        VALUES('delete', old.id, old.prompt_text);
        INSERT INTO user_prompts_fts(rowid, prompt_text)
        VALUES (new.id, new.prompt_text);
      END;
    `;try{this.db.run(t),this.db.run(n)}catch(r){r instanceof Error?_.warn("DB","FTS5 not available \u2014 user_prompts_fts skipped (search uses ChromaDB)",{},r):_.warn("DB","FTS5 not available \u2014 user_prompts_fts skipped (search uses ChromaDB)",{},new Error(String(r))),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),_.debug("DB","Created user_prompts table (without FTS5)");return}this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),_.debug("DB","Successfully created user_prompts table")}ensureDiscoveryTokensColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.query("PRAGMA table_info(observations)").all().some(o=>o.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),_.debug("DB","Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(o=>o.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),_.debug("DB","Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}createPendingMessagesTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}_.debug("DB","Creating pending_messages table"),this.db.run(`
      CREATE TABLE pending_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER NOT NULL,
        content_session_id TEXT NOT NULL,
        message_type TEXT NOT NULL CHECK(message_type IN ('observation', 'summarize')),
        tool_name TEXT,
        tool_input TEXT,
        tool_response TEXT,
        cwd TEXT,
        last_user_message TEXT,
        last_assistant_message TEXT,
        prompt_number INTEGER,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing')),
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),_.debug("DB","pending_messages table created successfully")}renameSessionIdColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17))return;_.debug("DB","Checking session ID columns for semantic clarity rename");let s=0,t=(n,r,o)=>{let a=this.db.query(`PRAGMA table_info(${n})`).all(),d=a.some(u=>u.name===r);return a.some(u=>u.name===o)?!1:d?(this.db.run(`ALTER TABLE ${n} RENAME COLUMN ${r} TO ${o}`),_.debug("DB",`Renamed ${n}.${r} to ${o}`),!0):(_.warn("DB",`Column ${r} not found in ${n}, skipping rename`),!1)};t("sdk_sessions","claude_session_id","content_session_id")&&s++,t("sdk_sessions","sdk_session_id","memory_session_id")&&s++,t("pending_messages","claude_session_id","content_session_id")&&s++,t("observations","sdk_session_id","memory_session_id")&&s++,t("session_summaries","sdk_session_id","memory_session_id")&&s++,t("user_prompts","claude_session_id","content_session_id")&&s++,this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString()),s>0?_.debug("DB",`Successfully renamed ${s} session ID columns`):_.debug("DB","No session ID column renames needed (already up to date)")}addFailedAtEpochColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(20))return;this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="failed_at_epoch")||(this.db.run("ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER"),_.debug("DB","Added failed_at_epoch column to pending_messages table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(20,new Date().toISOString())}addOnUpdateCascadeToForeignKeys(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(21))return;_.debug("DB","Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries"),this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TRIGGER IF EXISTS observations_ai"),this.db.run("DROP TRIGGER IF EXISTS observations_ad"),this.db.run("DROP TRIGGER IF EXISTS observations_au"),this.db.run("DROP TABLE IF EXISTS observations_new");let s=this.db.query("PRAGMA table_info(observations)").all(),t=s.some(g=>g.name==="metadata"),n=s.some(g=>g.name==="content_hash"),r=t?`,
        metadata TEXT`:"",o=t?", metadata":"",a=n?`,
        content_hash TEXT`:"",d=n?", content_hash":"",c=`
      CREATE TABLE observations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT,
        type TEXT NOT NULL,
        title TEXT,
        subtitle TEXT,
        facts TEXT,
        narrative TEXT,
        concepts TEXT,
        files_read TEXT,
        files_modified TEXT,
        prompt_number INTEGER,
        discovery_tokens INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL${r}${a},
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      )
    `,u=`
      INSERT INTO observations_new
      SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
             narrative, concepts, files_read, files_modified, prompt_number,
             discovery_tokens, created_at, created_at_epoch${o}${d}
      FROM observations
    `,l=`
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `,E=`
      CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
      END;

      CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
      END;

      CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
      END;
    `;this.db.run("DROP TRIGGER IF EXISTS session_summaries_ai"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_ad"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_au"),this.db.run("DROP TABLE IF EXISTS session_summaries_new");let f=`
      CREATE TABLE session_summaries_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read TEXT,
        files_edited TEXT,
        notes TEXT,
        prompt_number INTEGER,
        discovery_tokens INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      )
    `,A=`
      INSERT INTO session_summaries_new
      SELECT id, memory_session_id, project, request, investigated, learned,
             completed, next_steps, files_read, files_edited, notes,
             prompt_number, discovery_tokens, created_at, created_at_epoch
      FROM session_summaries
    `,S=`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `,b=`
      CREATE TRIGGER IF NOT EXISTS session_summaries_ai AFTER INSERT ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
      END;

      CREATE TRIGGER IF NOT EXISTS session_summaries_ad AFTER DELETE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
      END;

      CREATE TRIGGER IF NOT EXISTS session_summaries_au AFTER UPDATE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
      END;
    `;try{this.recreateObservationsWithCascade(c,u,l,E),this.recreateSessionSummariesWithCascade(f,A,S,b),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString()),this.db.run("COMMIT"),this.db.run("PRAGMA foreign_keys = ON"),_.debug("DB","Successfully added ON UPDATE CASCADE to FK constraints")}catch(g){throw this.db.run("ROLLBACK"),this.db.run("PRAGMA foreign_keys = ON"),g instanceof Error?g:new Error(String(g))}}recreateObservationsWithCascade(e,s,t,n){this.db.run(e),this.db.run(s),this.db.run("DROP TABLE observations"),this.db.run("ALTER TABLE observations_new RENAME TO observations"),this.db.run(t),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run(n)}recreateSessionSummariesWithCascade(e,s,t,n){this.db.run(e),this.db.run(s),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(t),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries_fts'").all().length>0&&this.db.run(n)}addObservationContentHashColumn(){if(this.db.query("PRAGMA table_info(observations)").all().some(t=>t.name==="content_hash")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString());return}this.db.run("ALTER TABLE observations ADD COLUMN content_hash TEXT"),this.db.run("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)"),_.debug("DB","Added content_hash column to observations table with backfill and index"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString())}addSessionCustomTitleColumn(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(23),t=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(n=>n.name==="custom_title");e&&t||(t||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT"),_.debug("DB","Added custom_title column to sdk_sessions table")),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(23,new Date().toISOString()))}addSessionPlatformSourceColumn(){let s=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(o=>o.name==="platform_source"),n=this.db.query("PRAGMA index_list(sdk_sessions)").all().some(o=>o.name==="idx_sdk_sessions_platform_source");this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(24)&&s&&n||(s||(this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${p}'`),_.debug("DB","Added platform_source column to sdk_sessions table")),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${p}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),n||this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(24,new Date().toISOString()))}addObservationModelColumns(){let e=this.db.query("PRAGMA table_info(observations)").all(),s=e.some(n=>n.name==="generated_by_model"),t=e.some(n=>n.name==="relevance_count");s&&t||(s||this.db.run("ALTER TABLE observations ADD COLUMN generated_by_model TEXT"),t||this.db.run("ALTER TABLE observations ADD COLUMN relevance_count INTEGER DEFAULT 0"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(26,new Date().toISOString()))}ensureMergedIntoProjectColumns(){this.db.query("PRAGMA table_info(observations)").all().some(t=>t.name==="merged_into_project")||this.db.run("ALTER TABLE observations ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into ON observations(merged_into_project)"),this.db.query("PRAGMA table_info(session_summaries)").all().some(t=>t.name==="merged_into_project")||this.db.run("ALTER TABLE session_summaries ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into ON session_summaries(merged_into_project)")}addObservationSubagentColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(27),s=this.db.query("PRAGMA table_info(observations)").all(),t=s.some(o=>o.name==="agent_type"),n=s.some(o=>o.name==="agent_id");t||this.db.run("ALTER TABLE observations ADD COLUMN agent_type TEXT"),n||this.db.run("ALTER TABLE observations ADD COLUMN agent_id TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_type ON observations(agent_type)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_id ON observations(agent_id)");let r=this.db.query("PRAGMA table_info(pending_messages)").all();if(r.length>0){let o=r.some(d=>d.name==="agent_type"),a=r.some(d=>d.name==="agent_id");o||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_type TEXT"),a||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_id TEXT")}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(27,new Date().toISOString())}ensurePendingMessagesToolUseIdColumn(){if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString());return}this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="tool_use_id")||this.db.run("ALTER TABLE pending_messages ADD COLUMN tool_use_id TEXT"),this.db.run("BEGIN TRANSACTION");try{this.dedupePendingMessagesByToolUseId(),this.db.run("COMMIT")}catch(n){this.db.run("ROLLBACK");let r=n instanceof Error?n:new Error(String(n));throw _.error("DB","Failed to de-dupe pending_messages by tool_use_id, rolled back",{},r),n}}dedupePendingMessagesByToolUseId(){this.db.run(`
      DELETE FROM pending_messages
       WHERE id IN (
         SELECT id
           FROM (
             SELECT id,
                    ROW_NUMBER() OVER (
                      PARTITION BY session_db_id, tool_use_id
                      ORDER BY CASE status
                        WHEN 'processing' THEN 0
                        WHEN 'pending' THEN 1
                        ELSE 2
                      END, id
                    ) AS duplicate_rank
               FROM pending_messages
              WHERE tool_use_id IS NOT NULL
           )
          WHERE duplicate_rank > 1
         )
    `),this.db.run(`
      -- tool_use_id is optional for summaries and legacy rows; enforce de-dupe
      -- only for rows that came from a concrete tool-use event.
      CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_session_tool
      ON pending_messages(session_db_id, tool_use_id)
      WHERE tool_use_id IS NOT NULL
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString())}addObservationsUniqueContentHashIndex(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(29))return;let s=this.db.query("PRAGMA table_info(observations)").all(),t=s.some(r=>r.name==="memory_session_id"),n=s.some(r=>r.name==="content_hash");if(!t||!n){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString());return}this.db.run("BEGIN TRANSACTION");try{this.dedupeObservationsByContentHash(),this.db.run("COMMIT")}catch(r){this.db.run("ROLLBACK");let o=r instanceof Error?r:new Error(String(r));throw _.error("DB","Failed to de-dupe observations by content_hash, rolled back",{},o),r}}dedupeObservationsByContentHash(){this.db.run(`
      UPDATE observations
         SET content_hash = '__null_migration_' || id || '__'
       WHERE content_hash IS NULL
    `),this.db.run(`
      DELETE FROM observations
       WHERE id IN (
         SELECT id
           FROM (
             SELECT id,
                    ROW_NUMBER() OVER (
                      PARTITION BY memory_session_id, content_hash
                      ORDER BY id
                    ) AS duplicate_rank
               FROM observations
           )
          WHERE duplicate_rank > 1
       )
    `),this.db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_observations_session_hash
      ON observations(memory_session_id, content_hash)
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString())}addObservationsMetadataColumn(){this.db.query("PRAGMA table_info(observations)").all().some(t=>t.name==="metadata")||(this.db.run("ALTER TABLE observations ADD COLUMN metadata TEXT"),_.debug("DB","Added metadata column to observations table (#2116)")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(30,new Date().toISOString())}enqueueRecoveryJob(e){let s=e.nowEpoch??Date.now(),t=e.nextAttemptAtEpoch??s,n=R(e.platformSource),r=e.recoveryKey??(0,j.createHash)("sha256").update([n,e.contentSessionId,e.recoveryKind,s].join(":")).digest("hex");return this.db.transaction(()=>{let a=e.recoveryKey?void 0:this.db.prepare(`
        SELECT id FROM recovery_jobs WHERE content_session_id=? AND recovery_kind=?
          AND status IN ('pending','running','retry_wait') LIMIT 1
      `).get(e.contentSessionId,e.recoveryKind);if(a||this.db.prepare(`
        INSERT OR IGNORE INTO recovery_jobs (
          content_session_id, recovery_kind, project, platform_source,
          transcript_locator, reason, first_failure_at_epoch,
          last_failure_at_epoch, next_attempt_at_epoch, provider, model,
          last_sanitized_error, created_at_epoch, updated_at_epoch, recovery_key,
          source_fingerprint, prompt_number, turn_id, parent_content_session_id,
          root_content_session_id, agent_id, transcript_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(e.contentSessionId,e.recoveryKind,e.project,n,e.transcriptLocator??null,e.reason,s,s,t,e.provider??null,e.model??null,e.sanitizedError??null,s,s,r,e.sourceFingerprint??null,e.promptNumber??null,e.turnId??null,e.parentContentSessionId??null,e.rootContentSessionId??null,e.agentId??null,e.transcriptSha256??null),a=a??(e.recoveryKey?this.db.prepare(`
        SELECT id FROM recovery_jobs WHERE recovery_key = ? LIMIT 1
      `).get(r):this.db.prepare(`
        SELECT id FROM recovery_jobs WHERE content_session_id=? AND recovery_kind=?
          AND status IN ('pending','running','retry_wait') LIMIT 1
      `).get(e.contentSessionId,e.recoveryKind)),!a)throw new Error("Failed to enqueue or locate active recovery job");return this.db.prepare(`
        UPDATE recovery_jobs
        SET status = CASE WHEN status = 'cancelled' AND ${U} THEN 'pending' ELSE status END,
            attempts = CASE WHEN status = 'cancelled' AND ${U} THEN 0 ELSE attempts END,
            completed_at_epoch = CASE WHEN status = 'cancelled' AND ${U} THEN NULL ELSE completed_at_epoch END,
            dead_letter_reason = CASE WHEN status = 'cancelled' AND ${U} THEN NULL ELSE dead_letter_reason END,
            lease_owner = CASE WHEN status = 'cancelled' AND ${U} THEN NULL ELSE lease_owner END,
            lease_expires_at_epoch = CASE WHEN status = 'cancelled' AND ${U} THEN NULL ELSE lease_expires_at_epoch END,
            cancellation_reason = CASE WHEN status = 'cancelled' AND ${U} THEN NULL ELSE cancellation_reason END,
            project = ?, platform_source = ?,
            transcript_locator = COALESCE(?, transcript_locator),
            reason = ?, last_failure_at_epoch = ?,
            next_attempt_at_epoch = CASE WHEN status = 'cancelled' AND ${U} THEN ? ELSE MIN(next_attempt_at_epoch, ?) END,
            provider = COALESCE(?, provider), model = COALESCE(?, model),
            last_sanitized_error = COALESCE(?, last_sanitized_error),
            source_fingerprint = COALESCE(?, source_fingerprint),
            transcript_sha256 = COALESCE(?, transcript_sha256),
            updated_at_epoch = ?
        WHERE id = ?
      `).run(e.project,n,e.transcriptLocator??null,e.reason,s,t,t,e.provider??null,e.model??null,e.sanitizedError??null,e.sourceFingerprint??null,e.transcriptSha256??null,s,a.id),this.getRecoveryJob(a.id)})()}getRecoveryJob(e){return this.db.prepare("SELECT * FROM recovery_jobs WHERE id = ?").get(e)??null}getRecoveryJobByKey(e){return this.db.prepare("SELECT * FROM recovery_jobs WHERE recovery_key=?").get(e)??null}getRecoveryJobCounts(){let e=this.db.prepare("SELECT status, COUNT(*) count FROM recovery_jobs GROUP BY status").all();return Object.fromEntries(e.map(s=>[s.status,s.count]))}releaseExpiredRecoveryLeases(e=Date.now()){return this.db.prepare(`
      UPDATE recovery_jobs
      SET status = 'retry_wait', lease_owner = NULL, lease_expires_at_epoch = NULL,
          next_attempt_at_epoch = MIN(next_attempt_at_epoch, ?), updated_at_epoch = ?
      WHERE status = 'running' AND lease_expires_at_epoch IS NOT NULL
        AND lease_expires_at_epoch <= ?
    `).run(e,e,e).changes}claimOldestRecoveryJob(e,s,t=Date.now()){if(!e.trim())throw new Error("Recovery lease owner is required");if(!Number.isSafeInteger(s)||s<=0)throw new Error("Recovery lease duration must be a positive integer");return this.db.transaction(()=>{this.releaseExpiredRecoveryLeases(t);let r=this.db.prepare(`
        SELECT id FROM recovery_jobs
        WHERE status IN ('pending', 'retry_wait') AND next_attempt_at_epoch <= ?
        ORDER BY created_at_epoch ASC, id ASC
        LIMIT 1
      `).get(t);if(!r)return null;let o=t+s;return this.db.prepare(`
        UPDATE recovery_jobs
        SET status = 'running', attempts = attempts + 1,
            lease_owner = ?, lease_expires_at_epoch = ?, updated_at_epoch = ?
        WHERE id = ? AND status IN ('pending', 'retry_wait')
      `).run(e,o,t,r.id).changes===1?this.getRecoveryJob(r.id):null})()}markRecoveryJobRetryWait(e,s,t,n,r=Date.now()){return this.db.prepare(`
      UPDATE recovery_jobs
      SET status = 'retry_wait', last_failure_at_epoch = ?, next_attempt_at_epoch = ?,
          last_sanitized_error = ?, lease_owner = NULL, lease_expires_at_epoch = NULL,
          updated_at_epoch = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ?
    `).run(r,t,n,r,e,s).changes===1}markRecoveryJobCompleted(e,s,t=Date.now()){return this.db.prepare(`
      UPDATE recovery_jobs
      SET status = 'completed', completed_at_epoch = ?, lease_owner = NULL,
          lease_expires_at_epoch = NULL, updated_at_epoch = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ?
    `).run(t,t,e,s).changes===1}renewRecoveryJobLease(e,s,t,n=Date.now()){return this.db.prepare(`
      UPDATE recovery_jobs SET lease_expires_at_epoch=?, updated_at_epoch=?
      WHERE id=? AND status='running' AND lease_owner=?
    `).run(n+t,n,e,s).changes===1}markRecoveryJobDeadLetter(e,s,t=Date.now(),n){let r=n===void 0?"status IN ('pending', 'retry_wait')":"status = 'running' AND lease_owner = ?";return this.db.prepare(`
      UPDATE recovery_jobs
      SET status = 'dead_letter', last_failure_at_epoch = ?, last_sanitized_error = ?, dead_letter_reason = ?,
          completed_at_epoch = ?, lease_owner = NULL, lease_expires_at_epoch = NULL,
          updated_at_epoch = ?
      WHERE id = ? AND ${r}
    `).run(t,s,s,t,t,e,...n===void 0?[]:[n]).changes===1}upsertSessionLineage(e,s,t,n,r=Date.now()){let o=`recovered:${R(t)}:${e}`;return this.db.prepare(`
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, user_prompt,
        started_at, started_at_epoch, status, parent_content_session_id, root_content_session_id,
        agent_id, agent_type, agent_path, agent_nickname, agent_depth, transcript_locator)
      VALUES (?, ?, ?, ?, '', ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform_source, content_session_id) DO NOTHING
    `).run(e,o,s,R(t),new Date(r).toISOString(),r,n.parentContentSessionId??null,n.rootContentSessionId??e,n.agentId??null,n.agentType??null,n.agentPath??null,n.agentNickname??null,n.agentDepth??0,n.transcriptLocator??null),this.db.prepare(`UPDATE sdk_sessions SET
      parent_content_session_id=COALESCE(parent_content_session_id, ?),
      root_content_session_id=COALESCE(root_content_session_id, ?), agent_id=COALESCE(agent_id, ?),
      agent_type=COALESCE(agent_type, ?), agent_path=COALESCE(agent_path, ?),
      agent_nickname=COALESCE(agent_nickname, ?), agent_depth=COALESCE(agent_depth, ?),
      transcript_locator=COALESCE(transcript_locator, ?)
      WHERE platform_source=? AND content_session_id=?`).run(n.parentContentSessionId??null,n.rootContentSessionId??null,n.agentId??null,n.agentType??null,n.agentPath??null,n.agentNickname??null,n.agentDepth??null,n.transcriptLocator??null,R(t),e),this.db.prepare("SELECT id, memory_session_id FROM sdk_sessions WHERE platform_source=? AND content_session_id=?").get(R(t),e)}hasSummaryFingerprint(e){return!!this.db.prepare("SELECT 1 FROM session_summaries WHERE source_fingerprint=? LIMIT 1").get(e)}getRecoverySummaryByFingerprint(e){return this.db.prepare(`SELECT id, memory_session_id, project, request, investigated, learned, completed, next_steps, notes, prompt_number, created_at_epoch
      FROM session_summaries WHERE source_fingerprint=? LIMIT 1`).get(e)??null}storeRecoverySummary(e,s,t,n,r,o){let a=this.db.prepare(`INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed, next_steps, notes,
       prompt_number, discovery_tokens, created_at, created_at_epoch, source_fingerprint)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT DO NOTHING RETURNING id`).get(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,r,new Date(o).toISOString(),o,n);if(a)return{id:a.id,createdAtEpoch:o,inserted:!0};let d=this.db.prepare("SELECT id, created_at_epoch FROM session_summaries WHERE source_fingerprint=?").get(n);return{id:d.id,createdAtEpoch:d.created_at_epoch,inserted:!1}}cancelRecoveryJob(e,s=Date.now(),t="manual"){return this.db.prepare(`
      UPDATE recovery_jobs
      SET status = 'cancelled', completed_at_epoch = ?, lease_owner = NULL,
          lease_expires_at_epoch = NULL, cancellation_reason = ?, updated_at_epoch = ?
      WHERE id = ? AND status IN ('pending', 'retry_wait')
    `).run(s,t,s,e).changes===1}resumeDeadLetterRecoveryJob(e,s=Date.now()){return this.db.prepare(`
      UPDATE recovery_jobs
      SET status = 'pending', next_attempt_at_epoch = ?, completed_at_epoch = NULL,
          dead_letter_reason = NULL, lease_owner = NULL, lease_expires_at_epoch = NULL,
          updated_at_epoch = ?
      WHERE id = ? AND status = 'dead_letter'
        AND transcript_locator IS NOT NULL AND source_fingerprint IS NOT NULL
        AND prompt_number IS NOT NULL AND turn_id IS NOT NULL
    `).run(s,s,e).changes===1}cancelSupersededTurnMismatchJobs(e,s,t,n,r,o=Date.now()){return this.db.prepare(`
      UPDATE recovery_jobs
      SET status = 'cancelled', completed_at_epoch = ?, lease_owner = NULL,
          lease_expires_at_epoch = NULL, cancellation_reason = 'superseded_turn_mismatch', updated_at_epoch = ?
      WHERE platform_source = ? AND content_session_id = ?
        AND prompt_number = ? AND turn_id = ? AND source_fingerprint <> ?
        AND status = 'dead_letter' AND dead_letter_reason LIKE 'turn_mismatch:%'
    `).run(o,o,R(e),s,t,n,r).changes}updateMemorySessionId(e,s){let t=this.db.prepare("SELECT memory_session_id FROM sdk_sessions WHERE id = ?").get(e);this.db.transaction(()=>{this.db.run("PRAGMA defer_foreign_keys = ON"),this.db.prepare(`
        UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?
      `).run(s,e),t?.memory_session_id&&s&&this.db.prepare(`
          UPDATE session_summaries SET memory_session_id = ? WHERE memory_session_id = ?
        `).run(s,t.memory_session_id)})(),s&&this.requeuePromptSync(e)}enqueueMutationOp(e,s){let t=JSON.parse(JSON.stringify(s));if(t.op==="set_prompt_session"){let n=t.target;n?.origin_device_id===null&&(n.origin_device_id="self")}z(t),this.db.prepare(`
      INSERT INTO sync_outbox (op_uuid, rev, body, created_at_epoch)
      VALUES (?, ?, ?, ?)
    `).run((0,j.randomUUID)(),String(e),JSON.stringify(s),Date.now())}requeuePromptSync(e){let s=this.db.prepare(`
      SELECT memory_session_id, project, content_session_id, platform_source
      FROM sdk_sessions WHERE id = ?
    `).get(e);if(!s?.memory_session_id)return;this.db.transaction(()=>{let n=this.db.prepare(`
        SELECT CAST(id AS TEXT) AS id, CAST(sync_rev AS TEXT) AS sync_rev FROM user_prompts
        WHERE session_db_id = ? AND origin_device_id IS NULL
      `).all(e);if(n.length!==0)for(let r of n){let o=Q(r.sync_rev);this.db.prepare(`
          UPDATE user_prompts SET sync_rev = ?, synced_at = NULL
          WHERE id = ? AND origin_device_id IS NULL
        `).run(o,r.id),this.enqueueMutationOp(o,{op:"set_prompt_session",target:{origin_device_id:null,origin_local_id:r.id},fields:{memory_session_id:s.memory_session_id,project:s.project,content_session_id:s.content_session_id,platform_source:s.platform_source}})}})()}markSessionCompleted(e){let s=Date.now(),t=new Date(s).toISOString();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(t,s,e)}ensureMemorySessionIdRegistered(e,s,t){let n=this.db.prepare(`
      SELECT id, memory_session_id, worker_port FROM sdk_sessions WHERE id = ?
    `).get(e);if(!n)throw new Error(`Session ${e} not found in sdk_sessions`);n.memory_session_id!==s&&(this.db.transaction(()=>{this.db.run("PRAGMA defer_foreign_keys = ON"),this.db.prepare(`
          UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?
        `).run(s,e),n.memory_session_id&&this.db.prepare(`
            UPDATE session_summaries SET memory_session_id = ? WHERE memory_session_id = ?
          `).run(s,n.memory_session_id)})(),this.requeuePromptSync(e),_.info("DB","Registered memory_session_id before storage (FK fix)",{sessionDbId:e,oldId:n.memory_session_id,newId:s})),typeof t=="number"&&n.worker_port!==t&&this.db.prepare(`
        UPDATE sdk_sessions SET worker_port = ? WHERE id = ?
      `).run(t,e)}getAllProjects(e){let s=e?R(e):void 0,t=`
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
    `,n=[W];return s&&(t+=" AND COALESCE(platform_source, ?) = ?",n.push(p,s)),t+=" ORDER BY project ASC",this.db.prepare(t).all(...n).map(o=>o.project)}getProjectCatalog(){let e=this.db.prepare(`
      SELECT
        COALESCE(platform_source, '${p}') as platform_source,
        project,
        MAX(started_at_epoch) as latest_epoch
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
      GROUP BY COALESCE(platform_source, '${p}'), project
      ORDER BY latest_epoch DESC
    `).all(W),s=[],t=new Set,n={};for(let o of e){let a=R(o.platform_source);n[a]||(n[a]=[]),n[a].includes(o.project)||n[a].push(o.project),t.has(o.project)||(t.add(o.project),s.push(o.project))}let r=_e(Object.keys(n));return{projects:s,sources:r,projectsBySource:Object.fromEntries(r.map(o=>[o,n[o]||[]]))}}getLatestUserPrompt(e,s){let t=this.resolvePromptSessionDbId(e,s),n=t!==null?"up.session_db_id = ?":"up.content_session_id = ?",r=t!==null?t:e;return this.db.prepare(`
      SELECT
        up.*,
        s.memory_session_id,
        s.project,
        COALESCE(s.platform_source, '${p}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE ${n}
      ORDER BY up.created_at_epoch DESC
      LIMIT 1
    `).get(r)}findRecentDuplicateUserPrompt(e,s,t,n){return ce(this.db,e,G(s),t,this.resolvePromptSessionDbId(e,n)??void 0)}getRecentSessionsWithStatus(e,s=3,t){let n=[e],r="";return t&&(r=`AND COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?`,n.push(R(t))),n.push(s),this.db.prepare(`
      SELECT * FROM (
        SELECT
          s.memory_session_id,
          s.status,
          s.started_at,
          s.started_at_epoch,
          s.user_prompt,
          CASE WHEN sum.memory_session_id IS NOT NULL THEN 1 ELSE 0 END as has_summary
        FROM sdk_sessions s
        LEFT JOIN session_summaries sum ON s.memory_session_id = sum.memory_session_id
        WHERE s.project = ? AND s.memory_session_id IS NOT NULL
        ${r}
        GROUP BY s.memory_session_id
        ORDER BY s.started_at_epoch DESC
        LIMIT ?
      )
      ORDER BY started_at_epoch ASC
    `).all(...n)}getObservationsForSession(e,s){let t=[e],n="";return s&&(n=`
        AND EXISTS (
          SELECT 1
          FROM sdk_sessions s
          WHERE s.memory_session_id = observations.memory_session_id
            AND COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?
        )
      `,t.push(R(s))),this.db.prepare(`
      SELECT title, subtitle, type, prompt_number
      FROM observations
      WHERE memory_session_id = ?
      ${n}
      ORDER BY created_at_epoch ASC
    `).all(...t)}getObservationById(e,s){return s?this.db.prepare(`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      WHERE o.id = ?
        AND COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?
    `).get(e,R(s))||null:this.db.prepare(`
        SELECT *
        FROM observations
        WHERE id = ?
      `).get(e)||null}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:n,project:r,platformSource:o,type:a,concepts:d,files:c}=s,u=t==="relevance",l=u?"":`ORDER BY o.created_at_epoch ${t==="date_asc"?"ASC":"DESC"}`,E=n&&!u?`LIMIT ${n}`:"",f=e.map(()=>"?").join(","),A=[...e],S=[];if(r&&(S.push("(o.project = ? OR o.merged_into_project = ?)"),A.push(r,r)),o&&(S.push(`COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?`),A.push(R(o))),a)if(Array.isArray(a)){let I=a.map(()=>"?").join(",");S.push(`o.type IN (${I})`),A.push(...a)}else S.push("o.type = ?"),A.push(a);if(d){let I=Array.isArray(d)?d:[d],h=I.map(()=>"EXISTS (SELECT 1 FROM json_each(o.concepts) WHERE value = ?)");A.push(...I),S.push(`(${h.join(" OR ")})`)}if(c){let I=Array.isArray(c)?c:[c],h=I.map(()=>"(EXISTS (SELECT 1 FROM json_each(o.files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(o.files_modified) WHERE value LIKE ?))");I.forEach(L=>{A.push(`%${L}%`,`%${L}%`)}),S.push(`(${h.join(" OR ")})`)}let b=S.length>0?`WHERE o.id IN (${f}) AND ${S.join(" AND ")}`:`WHERE o.id IN (${f})`,N=this.db.prepare(`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      ${b}
      ${l}
      ${E}
    `).all(...A);if(!u)return N;let C=new Map(N.map(I=>[I.id,I])),m=e.map(I=>C.get(I)).filter(I=>!!I);return n?m.slice(0,n):m}getSummaryForSession(e,s){let t=[e],n="";return s&&(n=`
        AND EXISTS (
          SELECT 1
          FROM sdk_sessions sdk
          WHERE sdk.memory_session_id = session_summaries.memory_session_id
            AND COALESCE(NULLIF(sdk.platform_source, ''), '${p}') = ?
        )
      `,t.push(R(s))),this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at,
        created_at_epoch
      FROM session_summaries
      WHERE memory_session_id = ?
      ${n}
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `).get(...t)||null}getSessionById(e){return this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${p}') as platform_source,
             user_prompt, custom_title, status, transcript_locator
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)||null}getSdkSessionsBySessionIds(e){if(e.length===0)return[];let s=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${p}') as platform_source,
             user_prompt, custom_title,
             started_at, started_at_epoch, completed_at, completed_at_epoch, status
      FROM sdk_sessions
      WHERE memory_session_id IN (${s})
      ORDER BY started_at_epoch DESC
    `).all(...e)}getPromptNumberFromUserPrompts(e,s){let t=this.resolvePromptSessionDbId(e,s);return t!==null?this.db.prepare(`
        SELECT COUNT(*) as count FROM user_prompts WHERE session_db_id = ?
      `).get(t).count:this.db.prepare(`
      SELECT COUNT(*) as count FROM user_prompts WHERE content_session_id = ?
    `).get(e).count}createSDKSession(e,s,t,n,r){let o=new Date,a=o.getTime(),d=r?R(r):p,c=G(t);n&&this.validateSetTitleMutation(e,d,n);let u=this.db.prepare(`
      SELECT id, platform_source
      FROM sdk_sessions
      WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
        AND content_session_id = ?
    `).get(p,d,e);if(u){if(s&&this.db.prepare(`
          UPDATE sdk_sessions SET project = ?
          WHERE id = ? AND (project IS NULL OR project = '')
        `).run(s,u.id),n){let E=this.db.prepare("SELECT custom_title FROM sdk_sessions WHERE id = ?").get(u.id);E&&E.custom_title===null&&(this.db.prepare(`
            UPDATE sdk_sessions SET custom_title = ?
            WHERE id = ? AND custom_title IS NULL
          `).run(n,u.id),this.enqueueSetTitleOp(e,d,n))}return u.id}let l=this.db.prepare(`
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'active')
    `).run(e,s,d,c,n||null,o.toISOString(),a);return n&&this.enqueueSetTitleOp(e,d,n),Number(l.lastInsertRowid)}enqueueSetTitleOp(e,s,t){let n=this.validateSetTitleMutation(e,s,t);this.enqueueMutationOp("1",n)}validateSetTitleMutation(e,s,t){let n={op:"set_title",target:{content_session_id:e,platform_source:s},fields:{custom_title:t}};return z(n),n}saveUserPrompt(e,s,t,n){let r=new Date,o=r.getTime(),a=G(t),d=this.resolvePromptSessionDbId(e,n);return this.db.prepare(`
      INSERT INTO user_prompts
      (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(d,e,s,a,r.toISOString(),o).lastInsertRowid}getUserPrompt(e,s,t){let n=this.resolvePromptSessionDbId(e,t);return n!==null?this.db.prepare(`
        SELECT prompt_text
        FROM user_prompts
        WHERE session_db_id = ? AND prompt_number = ?
        LIMIT 1
      `).get(n,s)?.prompt_text??null:this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,s)?.prompt_text??null}storeObservation(e,s,t,n,r=0,o,a){let d=this.storeObservations(e,s,[t],null,n,r,o,a);return{id:d.observationIds[0],createdAtEpoch:d.createdAtEpoch}}storeSummary(e,s,t,n,r=0,o){let a=o??Date.now(),d=new Date(a).toISOString(),u=this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,n||null,r,d,a);return{id:Number(u.lastInsertRowid),createdAtEpoch:a}}storeObservations(e,s,t,n,r,o=0,a,d){let c=a??Date.now(),u=new Date(c).toISOString();return this.db.transaction(()=>{let E=[],f=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
         generated_by_model, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_session_id, content_hash) DO NOTHING
        RETURNING id
      `),A=this.db.prepare("SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?");for(let b of t){let g=de(e,b.title,b.narrative),N=f.get(e,s,b.type,b.title,b.subtitle,JSON.stringify(b.facts),b.narrative,JSON.stringify(b.concepts),JSON.stringify(b.files_read),JSON.stringify(b.files_modified),r||null,o,b.agent_type??null,b.agent_id??null,g,u,c,d||null,b.metadata??null);if(N){E.push(N.id);continue}let C=A.get(e,g);if(!C)throw new Error(`storeObservations: ON CONFLICT without existing row for content_hash=${g}`);E.push(C.id)}let S=null;if(n){let g=this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(e,s,n.request,n.investigated,n.learned,n.completed,n.next_steps,n.notes,r||null,o,u,c);S=Number(g.lastInsertRowid)}return{observationIds:E,summaryId:S,createdAtEpoch:c}})()}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:n,project:r,platformSource:o}=s,a=t==="relevance",d=a?"":`ORDER BY ss.created_at_epoch ${t==="date_asc"?"ASC":"DESC"}`,c=n&&!a?`LIMIT ${n}`:"",u=e.map(()=>"?").join(","),l=[...e],E=[];r&&(E.push("(ss.project = ? OR ss.merged_into_project = ?)"),l.push(r,r)),o&&(E.push(`COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?`),l.push(R(o)));let f=E.length>0?`AND ${E.join(" AND ")}`:"",S=this.db.prepare(`
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id
      WHERE ss.id IN (${u}) ${f}
      ${d}
      ${c}
    `).all(...l);if(!a)return S;let b=new Map(S.map(N=>[N.id,N])),g=e.map(N=>b.get(N)).filter(N=>!!N);return n?g.slice(0,n):g}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:n,project:r,platformSource:o}=s,a=t==="relevance",d=a?"":`ORDER BY up.created_at_epoch ${t==="date_asc"?"ASC":"DESC"}`,c=n&&!a?`LIMIT ${n}`:"",u=e.map(()=>"?").join(","),l=[...e],E=[];r&&(E.push("s.project = ?"),l.push(r)),o&&(E.push(`COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?`),l.push(R(o)));let f=E.length>0?`AND ${E.join(" AND ")}`:"",S=this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id,
        COALESCE(NULLIF(s.platform_source, ''), '${p}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.id IN (${u}) ${f}
      ${d}
      ${c}
    `).all(...l);if(!a)return S;let b=new Map(S.map(N=>[N.id,N])),g=e.map(N=>b.get(N)).filter(N=>!!N);return n?g.slice(0,n):g}getTimelineAroundTimestamp(e,s=10,t=10,n,r){return this.getTimelineAroundObservation(null,e,s,t,n,r)}getTimelineAroundObservation(e,s,t=10,n=10,r,o){let a=o?R(o):void 0,d=(m,I,h=!1)=>{let L=[],k=[];return r&&(h?(L.push(`(${m}.project = ? OR ${m}.merged_into_project = ?)`),k.push(r,r)):(L.push(`${m}.project = ?`),k.push(r))),a&&(L.push(`COALESCE(NULLIF(${I}.platform_source, ''), '${p}') = ?`),k.push(a)),{clause:L.length>0?`AND ${L.join(" AND ")}`:"",params:k}},c=d("o","src",!0),u=d("ss","src",!0),l=d("s","s"),E,f;if(e!==null){let m=`
        SELECT o.id, o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.id <= ? ${c.clause}
        ORDER BY o.id DESC
        LIMIT ?
      `,I=`
        SELECT o.id, o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.id >= ? ${c.clause}
        ORDER BY o.id ASC
        LIMIT ?
      `;try{let h=this.db.prepare(m).all(e,...c.params,t+1),L=this.db.prepare(I).all(e,...c.params,n+1);if(h.length===0&&L.length===0)return{observations:[],sessions:[],prompts:[]};E=h.length>0?h[h.length-1].created_at_epoch:s,f=L.length>0?L[L.length-1].created_at_epoch:s}catch(h){return h instanceof Error?_.error("DB","Error getting boundary observations",{project:r},h):_.error("DB","Error getting boundary observations with non-Error",{},new Error(String(h))),{observations:[],sessions:[],prompts:[]}}}else{let m=`
        SELECT o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.created_at_epoch <= ? ${c.clause}
        ORDER BY o.created_at_epoch DESC
        LIMIT ?
      `,I=`
        SELECT o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.created_at_epoch >= ? ${c.clause}
        ORDER BY o.created_at_epoch ASC
        LIMIT ?
      `;try{let h=this.db.prepare(m).all(s,...c.params,t),L=this.db.prepare(I).all(s,...c.params,n+1);if(h.length===0&&L.length===0)return{observations:[],sessions:[],prompts:[]};E=h.length>0?h[h.length-1].created_at_epoch:s,f=L.length>0?L[L.length-1].created_at_epoch:s}catch(h){return h instanceof Error?_.error("DB","Error getting boundary timestamps",{project:r},h):_.error("DB","Error getting boundary timestamps with non-Error",{},new Error(String(h))),{observations:[],sessions:[],prompts:[]}}}let A=`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
      WHERE o.created_at_epoch >= ? AND o.created_at_epoch <= ? ${c.clause}
      ORDER BY o.created_at_epoch ASC
    `,S=`
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions src ON src.memory_session_id = ss.memory_session_id
      WHERE ss.created_at_epoch >= ? AND ss.created_at_epoch <= ? ${u.clause}
      ORDER BY ss.created_at_epoch ASC
    `,b=`
      SELECT up.*, s.project, s.memory_session_id, COALESCE(NULLIF(s.platform_source, ''), '${p}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${l.clause}
      ORDER BY up.created_at_epoch ASC
    `,g=this.db.prepare(A).all(E,f,...c.params),N=this.db.prepare(S).all(E,f,...u.params),C=this.db.prepare(b).all(E,f,...l.params);return{observations:g,sessions:N.map(m=>({id:m.id,memory_session_id:m.memory_session_id,project:m.project,request:m.request,completed:m.completed,next_steps:m.next_steps,created_at:m.created_at,created_at_epoch:m.created_at_epoch})),prompts:C.map(m=>({id:m.id,content_session_id:m.content_session_id,prompt_number:m.prompt_number,prompt_text:m.prompt_text,project:m.project,platform_source:m.platform_source,created_at:m.created_at,created_at_epoch:m.created_at_epoch}))}}getOrCreateManualSession(e){let s=`manual-${e}`,t=`manual-content-${e}`;if(this.db.prepare("SELECT memory_session_id FROM sdk_sessions WHERE memory_session_id = ?").get(s))return s;let r=new Date;return this.db.prepare(`
      INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, platform_source, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(s,t,e,p,r.toISOString(),r.getTime()),_.info("SESSION","Created manual session",{memorySessionId:s,project:e}),s}close(){this.db.close()}importSdkSession(e){let s=R(e.platform_source),t=this.db.prepare(`SELECT id FROM sdk_sessions
       WHERE platform_source = ? AND content_session_id = ?`).get(s,e.content_session_id);return t?{imported:!1,id:t.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO sdk_sessions (
        content_session_id, memory_session_id, project, platform_source, user_prompt,
        started_at, started_at_epoch, completed_at, completed_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.content_session_id,e.memory_session_id,e.project,s,e.user_prompt,e.started_at,e.started_at_epoch,e.completed_at,e.completed_at_epoch,e.status).lastInsertRowid}}importSessionSummary(e){let s=this.db.prepare("SELECT id FROM session_summaries WHERE memory_session_id = ?").get(e.memory_session_id);return s?{imported:!1,id:s.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO session_summaries (
        memory_session_id, project, request, investigated, learned,
        completed, next_steps, files_read, files_edited, notes,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.memory_session_id,e.project,e.request,e.investigated,e.learned,e.completed,e.next_steps,e.files_read,e.files_edited,e.notes,e.prompt_number,e.discovery_tokens||0,e.created_at,e.created_at_epoch).lastInsertRowid}}importObservation(e){let s=this.db.prepare(`
      SELECT id FROM observations
      WHERE memory_session_id = ? AND title = ? AND created_at_epoch = ?
    `).get(e.memory_session_id,e.title,e.created_at_epoch);return s?{imported:!1,id:s.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO observations (
        memory_session_id, project, text, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified,
        prompt_number, discovery_tokens, agent_type, agent_id,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.memory_session_id,e.project,e.text,e.type,e.title,e.subtitle,e.facts,e.narrative,e.concepts,e.files_read,e.files_modified,e.prompt_number,e.discovery_tokens||0,e.agent_type??null,e.agent_id??null,e.created_at,e.created_at_epoch).lastInsertRowid}}rebuildObservationsFTSIndex(){this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')")}importUserPrompt(e){let s=null,t=e.platform_source?R(e.platform_source):void 0;if(typeof e.session_db_id=="number"){let a=this.db.prepare(`
        SELECT id, content_session_id, COALESCE(NULLIF(platform_source, ''), '${p}') as platform_source
        FROM sdk_sessions
        WHERE id = ?
        LIMIT 1
      `).get(e.session_db_id);a&&a.content_session_id===e.content_session_id&&(!t||R(a.platform_source)===t)&&(s=a.id)}s===null&&(s=this.resolvePromptSessionDbId(e.content_session_id,void 0,t));let n=this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE ${s!==null?"session_db_id = ?":"content_session_id = ?"} AND prompt_number = ?
    `).get(s??e.content_session_id,e.prompt_number);return n?{imported:!1,id:n.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO user_prompts (
        session_db_id, content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(s,e.content_session_id,e.prompt_number,e.prompt_text,e.created_at,e.created_at_epoch).lastInsertRowid}}};0&&(module.exports={SessionStore});

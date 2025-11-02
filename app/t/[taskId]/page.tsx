import Image from "next/image";

function qp(searchParams: URLSearchParams, key: string, fallback = "") {
  return searchParams.get(key) ?? fallback;
}

export default function TaskPage({ params, searchParams }: {
  params: { taskId: string },
  searchParams: { [key: string]: string | string[] | undefined }
}) {
  const sp = new URLSearchParams(Object.entries(searchParams).flatMap(([k,v]) => {
    if (Array.isArray(v)) return v.map(val => [k, val]);
    return v ? [[k, String(v)]] : [];
  }));
  const taskId = params.taskId;
  const title = qp(sp, "title", "Untitled Task");
  const client = qp(sp, "client", "Client");
  const due = qp(sp, "due", "");
  const preview = qp(sp, "preview", "");

  const webhook = process.env.NEXT_PUBLIC_WEBHOOK_URL || "https://hook.eu1.make.com/replace-this-with-your-webhook";

  return (
    <main style={{display:"flex", justifyContent:"center", padding: 24}}>
      <div style={{maxWidth:820, width:"100%", border:"1px solid #e5e7eb", borderRadius:16, padding:24}}>
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"center"}}>
          <h1 style={{margin:0}}>Client Review</h1>
          <span style={{border:"1px solid #e5e7eb", padding:"4px 10px", borderRadius:999, fontSize:12}}>Task: {taskId}</span>
        </div>
        <p><strong>{title}</strong> — for <strong>{client}</strong></p>
        <p style={{opacity:0.7}}>Due: {due || "—"}</p>

        <div style={{margin:"12px 0 18px 0"}}>
          {preview ? (
            <>
              <img src={preview} alt="Preview" style={{maxWidth:"100%", borderRadius:10}} />
              <p><a href={preview} target="_blank" rel="noopener">Open full image ↗</a></p>
            </>
          ) : <em>No preview provided.</em>}
        </div>

        <form method="POST" action="/api/reply" style={{marginTop: 8}}>
          <fieldset style={{border:"none", padding:0, margin:"0 0 12px 0"}}>
            <legend style={{fontWeight:600, marginBottom:8}}>Decision</legend>
            <label style={{display:"block"}}><input type="radio" name="decision" value="approve" /> Approve ✅</label>
            <label style={{display:"block"}}><input type="radio" name="decision" value="needs_changes" /> Needs changes 🔄</label>
          </fieldset>

          <label style={{display:"block", fontWeight:600, marginTop:12}}>Notes</label>
          <textarea name="notes" rows={4} placeholder="Optional notes (required if requesting changes)" style={{width:"100%", padding:"10px 12px", border:"1px solid #d1d5db", borderRadius:10}} />

          <input type="hidden" name="taskId" value={taskId} />
          <input type="hidden" name="title" value={title} />
          <input type="hidden" name="client" value={client} />
          <input type="hidden" name="due" value={due} />
          <input type="hidden" name="preview" value={preview} />

          <div style={{display:"flex", gap:12, marginTop:16, alignItems:"center"}}>
            <button type="submit" style={{padding:"10px 16px", borderRadius:10, border:0, background:"#111827", color:"#fff", cursor:"pointer"}}>Send review</button>
            <a href={`/?task=${taskId}`} style={{border:"1px solid #9ca3af", padding:"10px 16px", borderRadius:10, textDecoration:"none"}}>Reset</a>
          </div>
          <p style={{opacity:0.7, fontSize:12, marginTop:8}}>Submitting will POST fields: decision, notes, taskId, title, client, due, preview.</p>
        </form>
      </div>
    </main>
  );
}

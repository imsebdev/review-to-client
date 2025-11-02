        </div>

        {/* --- Client decision form --- */}
        <form
          method="POST"
          action="/api/reply"
          className="rounded-2xl bg-white/5 border border-white/10 p-6 space-y-4"
        >
          <h3 className="text-lg font-medium">Send your review</h3>

          <fieldset className="space-y-2">
            <legend className="text-sm text-zinc-400 mb-1">Decision</legend>
            <label className="block">
              <input type="radio" name="decision" value="approve" className="mr-2" /> Approve ✅
            </label>
            <label className="block">
              <input type="radio" name="decision" value="needs_changes" className="mr-2" /> Needs changes 🔄
            </label>
          </fieldset>

          <div>
            <label className="block text-sm text-zinc-400 mb-1" htmlFor="notes">
              Notes
            </label>
            <textarea
              id="notes"
              name="notes"
              rows={4}
              placeholder="Optional notes (required if requesting changes)"
              className="w-full rounded-lg border border-white/10 bg-transparent p-3"
            />
          </div>

          {/* Hidden fields so Zapier knows which task this is */}
          <input type="hidden" name="taskId" value={taskId} />
          <input type="hidden" name="title" value={title} />
          <input type="hidden" name="client" value={client} />
          <input type="hidden" name="due" value={due} />
          <input type="hidden" name="preview" value={preview} />

          <button
            type="submit"
            className="rounded-lg bg-white text-zinc-900 px-4 py-2 text-sm font-medium hover:opacity-90"
          >
            Send review
          </button>
        </form>

        <p className="text-xs text-zinc-500">
          Tip: add <code>?title=&client=&due=&preview=</code> query params to control the page.
        </p>

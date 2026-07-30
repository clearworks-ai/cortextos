# 🎓 JobTread /todo Slack Automation

---

# 📄 **JobTread /todo Slack Automation SOP**

### 🔗 **Reference Documents**

Before beginning this SOP:

- Review the gap this closes here → [**Alloi AI Operations Audit (2026-07-17), Gap G2**](~/code/knowledge-sync/raw/areas/clearworks/clients/alloi/alloi-ai-operations-audit-2026-07-17.txt)
- Review deploy setup + Railway approval gotcha here → [**DEPLOY.md**](~/code/jobtread-automation/DEPLOY.md)

---

### 🎯 **Purpose**

The team records changes, RFIs, progress, decisions, and to-dos in Slack, but nothing carries those items into JobTread as structured, trackable entries — items get re-typed by hand, or never make it in at all. This automation was built so a to-do typed in Slack becomes a real, tracked JobTread task instead of getting re-typed by hand or lost — closing the gap Josh identified directly (Alloi audit, Gap G2). It resolves Pain 1 (Slack decisions unfindable), Pain 8 (tactical to-dos lost week to week), Pain 13 (notes don't convert to tracked action items), and Pain 15 (same info entered multiple times).

---

### 👥 **Who This SOP Is For**

- Any Alloi team member who wants to create a JobTread to-do without opening JobTread
- PMs and superintendents tracking tactical items during a Slack conversation
- Any team member responsible for job task follow-through

---

### 🧠 **Overview**

A Slack slash command (`/todo`) creates a to-do task directly on a JobTread job, using a JobTread API grant behind the scenes. Two usage modes exist: a guided modal (pick job/assignee/date/title from a form) and a no-modal inline mode (type everything in one line, fastest for repeat use). Runs on Railway (project `upbeat-expression`), calling the JobTread API with a dedicated grant key.

---

## 🪜 **Step-by-Step Process**

---

### **STEP 1 – Create a to-do the fast way (no modal)**

- In any Slack channel, type:
  ```
  /todo #jobcode @username M/DD Title
  ```
- Example:
  ```
  /todo #2516ar @username 8/1 the best title
  ```
- Fields, in order (order-flexible — `#job` / `@assignee` / date token can appear in any order):
    - `#jobcode` — the JobTread job code (e.g. `#2516ar`)
    - `@username` — Slack username of the assignee (required, no default)
    - date — accepted formats: `M/D`, `M/D/YY`, `M/D/YYYY`, or `YYYY-MM-DD`
    - Title — everything else, becomes the to-do's title
- Confirm:
    - ✅ Slack shows a confirmation reply with the job name + assignee + due date
    - ✅ Task appears on the correct job's board in JobTread, flagged as a to-do (not just a task)

🧠 **Note:** Job and assignee are fuzzy-matched. If ambiguous, Slack replies with up to 5 candidate matches to pick from instead of guessing.

---

### **STEP 2 – Create a to-do the guided way (modal)**

- In any Slack channel, type `/todo` with no arguments.
- A modal opens with fields for: job, assignee, date, title.
- Fill in each field and submit.
- Confirm:
    - ✅ Modal closes without an error banner
    - ✅ Task appears on the correct job's board in JobTread, flagged as a to-do

📌 **Tip:** Use the modal when you're not sure of the exact job code or Slack handle — it's pickable from a list. Use the no-modal format (Step 1) once you know the codes, it's faster.

---

## 🗂️ **Checklist Before Marking Complete**

✅ To-do visible on the correct JobTread job board
✅ To-do flagged as a to-do (`isToDo:true`), not just a plain task
✅ Assignee and due date match what was typed in Slack
✅ No duplicate to-do created for the same input (dedup guard should block re-submits)

---

## 🧠 **Notes & Reminders**

- Job codes map to JobTread jobs; if a job has its tasks split into groups vs. leaf tasks, the automation always attaches the new to-do under the job's first group-level task, not a random leaf task — this was a fixed bug (some jobs' first task was a leaf task and the API rejected it).
- Never assume a to-do landed if Slack didn't confirm it — check JobTread directly if unsure.
- This automation requires a live JobTread API grant (`JOBTREAD_GRANT_KEY` + `JOBTREAD_ORG_ID`) tied to Alloi's org. If the grant expires or is revoked, the command will fail — escalate to Tech/IT.

---

## 📞 **Escalation**

- **Owner:** Josh (Clearworks)
- **Escalation contact:** Josh — Telegram/Slack
- **When to escalate:** If `/todo` returns an error, if a to-do doesn't appear in JobTread after confirmation, or if a Railway deploy is pending manual approval (blocks all `/todo` traffic until approved).

---

## 📅 **Metadata**

| Field | Value |
|---|---|
| Business | alloi |
| Department | operations |
| Created | 2026-07-30 |
| Last updated | 2026-07-30 |
| Version | 1.0 |
| Author | larry (self-answered from known build facts + auditmaster context, per Josh's request to skip interview) |

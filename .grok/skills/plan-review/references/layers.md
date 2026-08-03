# Layers & UI (review companion)

Use with plan-review §5 and create-plan layer tables.

## Ownership (must match feature-divide)

| Concern | Owner |
|---------|--------|
| `/harness` route, nav, Wasm load | DOM |
| Bridge glue, poll submit, history fold | DOM |
| `POST /api/chat`, secrets | Vercel backend |
| SessionStore (current) | DOM |
| Transcript, composer, agent chrome | **Harness (Wasm)** |
| Turn error presentation | Harness (EMBER) |

## Blockers

1. **Dual chat** — DOM bubbles + composer as product path while canvas is secondary  
2. **Secrets in Wasm/client**  
3. **Unmitigated layout shift** of primary host actions across load/ready/error  
4. **Layer TBD** for in-scope user-visible work  

## Reusability (review prompts)

- Does this plan hardcode a single deployment identity into harness logic?  
- Are env/project seams named so another operator could point at their Vercel?  
- If multi-tenant/sandbox is out of scope, is that explicit without closing the door?  

## Operator checklist seeds (UI plans)

- [ ] Open `/harness` — canvas is workspace  
- [ ] Type + send in canvas  
- [ ] Read assistant in canvas  
- [ ] Second turn uses history  
- [ ] Refresh restores session into Wasm  
- [ ] ~390px width usable  
- [ ] Host nav/status does not steal the session  

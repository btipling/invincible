# Invincible — project IDs and URLs

- **Vercel project name:** invincible
- **Vercel team:** Bjorn's projects (`bjorns-projects-65588ed4`)
- **teamId:** `team_dS9oFKboGzOH94QwyQ4GMFj2`
- **projectId:** `prj_x8VWfNE5KiKXqqHNwm8IYPzokaS5`
- **Production:** https://invincible-dun-ten.vercel.app
- **Dashboard:** https://vercel.com/bjorns-projects-65588ed4/invincible
- **GitHub:** https://github.com/btipling/invincible (`main`)

## Env (set in Vercel, not in git)

| Name | Required | Notes |
|------|----------|--------|
| `AI_GATEWAY_API_KEY` | yes | Project → Settings → Environment Variables → Production + Preview |
| `DEFAULT_MODEL` | no | default `xai/grok-4.1-fast-non-reasoning` |

After adding env vars, **Redeploy** the production deployment.

## Git integration (optional but recommended)

This first production deploy was file-based (not auto from Git). To mirror Asteronica:

1. Vercel project → **Settings → Git**
2. Connect `btipling/invincible`
3. Production branch: `main`

Then push to `main` triggers production deploys.

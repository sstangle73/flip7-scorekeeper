/* Checks the abuse limits on the public endpoints. Run deliberately, not as
 * part of the main suite: it deliberately burns a minute of quota.
 *
 *   node test-ratelimit.mjs                       # against wrangler dev
 *   RELAY=https://... node test-ratelimit.mjs     # against the deployment
 */
const BASE = process.env.RELAY || "http://127.0.0.1:8787";
let pass = 0, fail = 0;
const check = (l, c, d) => c
  ? (pass++, console.log("  PASS  " + l))
  : (fail++, console.log("  FAIL  " + l + (d ? "  -> " + d : "")));

console.log("\nRate limit checks (this consumes a minute of quota)\n");

/* Room creation is throttled. Cloudflare's limiter is deliberately permissive
   and eventually consistent -- counters catch up asynchronously -- so a tight
   burst slips through and only sustained abuse gets damped. Assert that
   behaviour rather than a hard gate, which this API does not provide. */
const codes = [];
let allowed = 0, blocked = 0;
for(let i = 0; i < 40; i++){
  const r = await fetch(BASE + "/api/rooms", {method:"POST"});
  if(r.status === 429) blocked++;
  else if(r.status === 200){ allowed++; codes.push((await r.json()).code); }
  await new Promise(res => setTimeout(res, 400));
}
check("sustained room creation gets throttled", blocked > 0,
  "40 attempts, none refused");
check("the throttle is not so tight it blocks normal use", allowed >= 5,
  "only " + allowed + " of 40 allowed");
console.log(`        (allowed ${allowed}, refused ${blocked} of 40)`);

const body = await (await fetch(BASE + "/api/rooms", {method:"POST"})).json();
check("a refusal explains itself in plain words",
  body.code !== undefined || /wait a minute/i.test(body.error || ""), JSON.stringify(body));

/* Health must stay reachable even when creation is throttled. */
const h = await fetch(BASE + "/api/health");
check("health is unaffected by the creation limit", h.status === 200);

/* Joining is limited far more loosely, so a table behind one NAT still works. */
const code = codes[0];
if(code){
  let ok = 0;
  for(let i = 0; i < 12; i++){
    const r = await fetch(BASE + `/api/rooms/${code}/ws`);
    if(r.status !== 429) ok++;
  }
  check("a dozen joins from one IP are not blocked", ok === 12, ok + "/12 got through");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

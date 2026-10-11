import {afterEach,expect,it,vi} from "vitest";
import {makeFunctionReference} from "convex/server";
import {createWidgetBackend,seedGeographicWidget,addAssuredOrganizationUser} from "./widgetTestHelpers.fixture";
import {readyStoreName} from "./jurisdictions";
const resolve=makeFunctionReference<"query">("jurisdictions:resolveChatResearchStores");
afterEach(()=>vi.unstubAllEnvs());
async function fixture(){vi.stubEnv("ADMIN_ENVIRONMENT","production");const t=createWidgetBackend(),f=await seedGeographicWidget(t),user=await addAssuredOrganizationUser(t);return {t,f,user};}
async function addition(input:Awaited<ReturnType<typeof fixture>>,status:"draft"|"failed"|"publishing"="publishing",jobStatus:"queued"|"manual_review"="manual_review"){
  return await input.t.run(async ctx=>{
    const resource=(await ctx.db.get(input.f.resourceId))!,version=(await ctx.db.get(input.f.versionId))!;
    const {_id:_r,_creationTime:_rc,...r}=resource,{_id:_v,_creationTime:_vc,...v}=version;
    const resourceId=await ctx.db.insert("legalResources",{...r,title:"Unpublished addition",activeVersionId:undefined,catalogPublished:false});
    const versionId=await ctx.db.insert("documentVersions",{...v,resourceId,status,geminiDocumentName:undefined});
    if(status!=="publishing")return {resourceId,versionId};
    const now=Date.now(),idempotencyKey="availability-addition",operationName=`${input.f.storeName}/upload/operations/pending`;
    const jobId=await ctx.db.insert("integrationJobs",{type:"gemini_index_document",targetType:"documentVersion",targetId:versionId,
      payload:JSON.stringify({operation:"publish",storeName:input.f.storeName,sha256:v.sha256}),actorId:"fixture",actorRoles:["content_manager"],idempotencyKey,requestFingerprint:"fixture",correlationId:"fixture",
      status:jobStatus,attemptCount:1,...(jobStatus==="manual_review"?{providerOperationName:operationName,recoveryKind:"poll_operation" as const,lastErrorKind:"timeout" as const}:{}),createdAt:now,updatedAt:now});
    const lockId=await ctx.db.insert("documentLifecycleLocks",{resourceId,versionId,jurisdictionId:input.f.jurisdictionId,operation:"publish",actorId:"fixture",idempotencyKey,jobId,expiresAt:now+3600000,createdAt:now,updatedAt:now});
    return {resourceId,versionId,jobId,lockId};
  });
}
const manifest=async(input:Awaited<ReturnType<typeof fixture>>)=>await input.user.client.query(resolve,{jurisdictionId:input.f.jurisdictionId,publicationFilterProtocol:"published-v1"});
it.each(["draft","failed","publishing"] as const)("synced published sources remain available and positively filtered beside %s additions",async status=>{
  const input=await fixture(),newDocument=await addition(input,status);const result=await manifest(input);
  expect(result.partialCoverage).toBe(false);expect(result.stores[0].publicationFilter.documents).toEqual([{resourceId:input.f.resourceId,versionId:input.f.versionId,sha256:"0".repeat(64)}]);
  expect(result.stores[0].publicationFilter.documents.some((value:{versionId:string})=>value.versionId===newDocument.versionId)).toBe(false);
});
it("drift fully explained by a locked disjoint initial addition retains published research without changing provider state",async()=>{
  const input=await fixture();await addition(input);await input.t.run(ctx=>ctx.db.patch(input.f.jurisdictionId,{providerSyncState:"drifted"}));
  expect((await manifest(input)).stores[0].publicationFilter.documents).toHaveLength(1);
  expect((await input.t.run(ctx=>ctx.db.get(input.f.jurisdictionId)))?.providerSyncState).toBe("drifted");
});
it.each(["unexplained drift","store pending","store failed","published lock","teardown","malformed addition","addition auth error","duplicate document","broken catalogue","foreign operation","missing lock","actor mismatch","unattributable job","invalid reason"])("fails closed for %s",async scenario=>{
  const input=await fixture();const candidate=await addition(input);
  await input.t.run(async ctx=>{
    if(scenario==="unexplained drift"){await ctx.db.patch(input.f.jurisdictionId,{providerSyncState:"drifted"});await ctx.db.delete(candidate.jobId!);await ctx.db.delete(candidate.lockId!);}
    if(scenario==="store pending")await ctx.db.patch(input.f.jurisdictionId,{providerSyncState:"pending"});
    if(scenario==="store failed")await ctx.db.patch(input.f.jurisdictionId,{providerSyncState:"failed"});
    if(scenario==="published lock")await ctx.db.insert("documentLifecycleLocks",{resourceId:input.f.resourceId,versionId:input.f.versionId,jurisdictionId:input.f.jurisdictionId,operation:"unpublish",actorId:"fixture",idempotencyKey:"published-lock",expiresAt:Date.now()+3600000,createdAt:Date.now(),updatedAt:Date.now()});
    if(scenario==="teardown")await ctx.db.patch(candidate.jobId!,{type:"gemini_delete_store",targetType:"jurisdictionGeminiStore",targetId:input.f.jurisdictionId,payload:JSON.stringify({storeName:input.f.storeName})});
    if(scenario==="malformed addition")await ctx.db.patch(candidate.jobId!,{payload:JSON.stringify({operation:"replace_index",storeName:input.f.storeName,sha256:"0".repeat(64),previousVersionId:input.f.versionId})});
    if(scenario==="addition auth error")await ctx.db.patch(candidate.jobId!,{lastErrorKind:"authentication"});
    if(scenario==="broken catalogue")await ctx.db.patch(input.f.resourceId,{catalogPublished:false});
    if(scenario==="foreign operation")await ctx.db.patch(candidate.jobId!,{providerOperationName:"fileSearchStores/foreign/upload/operations/pending"});
    if(scenario==="missing lock")await ctx.db.delete(candidate.lockId!);
    if(scenario==="actor mismatch")await ctx.db.patch(candidate.lockId!,{actorId:"another-actor"});
    if(scenario==="unattributable job")await ctx.db.patch(candidate.jobId!,{targetId:"unknown-version"});
    if(scenario==="invalid reason")await ctx.db.patch(candidate.jobId!,{payload:JSON.stringify({operation:"publish",storeName:input.f.storeName,sha256:"0".repeat(64),reasonDigest:"invalid"})});
    if(scenario==="duplicate document"){
      const version=(await ctx.db.get(input.f.versionId))!;await ctx.db.patch(candidate.versionId,{status:"published",geminiDocumentName:version.geminiDocumentName});await ctx.db.patch(candidate.resourceId,{activeVersionId:candidate.versionId,catalogPublished:true});await ctx.db.delete(candidate.jobId!);await ctx.db.delete(candidate.lockId!);
    }
  });
  await expect(manifest(input)).rejects.toThrow("CHAT_RESEARCH_STORE_NOT_READY");
});

it("filters a complete larger selected and ancestor scope without losing source tuples", async () => {
  const input = await fixture(), parent = await seedGeographicWidget(input.t);
  await input.t.run(async ctx => {
    const childProfile = await ctx.db.query("geographicJurisdictions").withIndex("by_jurisdictionId", q => q.eq("jurisdictionId", input.f.jurisdictionId)).unique();
    const parentProfile = await ctx.db.query("geographicJurisdictions").withIndex("by_jurisdictionId", q => q.eq("jurisdictionId", parent.jurisdictionId)).unique();
    await ctx.db.patch(childProfile!._id, { parentJurisdictionId: parent.jurisdictionId });
    await ctx.db.patch(parentProfile!._id, { level: "state" });
    for (const [library, count] of [[input.f, 100], [parent, 63]] as const) {
      const originalResource = (await ctx.db.get(library.resourceId))!, originalVersion = (await ctx.db.get(library.versionId))!;
      const { _id: _r, _creationTime: _rc, ...resource } = originalResource, { _id: _v, _creationTime: _vc, ...version } = originalVersion;
      for (let index = 0; index < count; index++) {
        const resourceId = await ctx.db.insert("legalResources", { ...resource, activeVersionId: undefined, catalogPublished: false });
        const versionId = await ctx.db.insert("documentVersions", { ...version, resourceId, geminiDocumentName: `${library.storeName}/documents/scope${index}` });
        await ctx.db.patch(resourceId, { activeVersionId: versionId, catalogPublished: true });
      }
    }
  });
  const result = await manifest(input);
  expect(result.stores.map((store:{publicationFilter:{documents:unknown[]}}) => store.publicationFilter.documents.length)).toEqual([101,64]);
  expect(result.authorizedScopeSize).toBe(2); expect(result.partialCoverage).toBe(false);
});

it("does not disable clean legacy stores for an unindexed draft version of an already published resource", async () => {
  const input = await fixture();
  await input.t.run(async ctx => {
    const { _id: _v, _creationTime: _vc, ...version } = (await ctx.db.get(input.f.versionId))!;
    await ctx.db.insert("documentVersions", { ...version, versionNumber: 2, status: "draft", geminiDocumentName: undefined });
  });
  expect(await input.t.run(ctx => readyStoreName(ctx, input.f.jurisdictionId))).toBe(input.f.storeName);
  expect((await manifest(input)).stores[0].publicationFilter.documents).toHaveLength(1);
});

it.each(["orphan", "foreign"])("handles %s legacy lifecycle locks without guessing their scope", async scope => {
  const input = await fixture(), foreign = await seedGeographicWidget(input.t);
  await input.t.run(async ctx => {
    await ctx.db.insert("documentLifecycleLocks", { resourceId: foreign.resourceId, versionId: foreign.versionId,
      operation: "unpublish", actorId: "fixture", idempotencyKey: "legacy-foreign", expiresAt: Date.now()+1000, createdAt: Date.now(), updatedAt: Date.now() });
    if (scope === "orphan") await ctx.db.delete(foreign.resourceId);
  });
  if (scope === "orphan") await expect(manifest(input)).rejects.toThrow("CHAT_RESEARCH_STORE_NOT_READY");
  else expect((await manifest(input)).stores[0].publicationFilter.documents).toHaveLength(1);
});
it("legacy clean healthy widgets keep their existing ready store, while pending additions deny unfiltered callers",async()=>{
  const input=await fixture();expect(await input.t.run(ctx=>readyStoreName(ctx,input.f.jurisdictionId))).toBe(input.f.storeName);
  await addition(input);expect(await input.t.run(ctx=>readyStoreName(ctx,input.f.jurisdictionId))).toBeNull();
  await expect(input.user.client.query(resolve,{jurisdictionId:input.f.jurisdictionId})).rejects.toThrow("CHAT_RESEARCH_STORE_NOT_READY");
});
it("a jurisdiction with no published version stays unavailable",async()=>{const input=await fixture();await addition(input,"failed");await input.t.run(ctx=>ctx.db.patch(input.f.resourceId,{activeVersionId:undefined,catalogPublished:false}));await expect(manifest(input)).rejects.toThrow("CHAT_RESEARCH_STORE_NOT_READY");});

it("preserves a complete clean catalogue and filters all 65 published sources when it becomes partial", async () => {
  const input = await fixture();
  await input.t.run(async ctx => {
    const originalResource = (await ctx.db.get(input.f.resourceId))!, originalVersion = (await ctx.db.get(input.f.versionId))!;
    const { _id: _r, _creationTime: _rc, ...resource } = originalResource, { _id: _v, _creationTime: _vc, ...version } = originalVersion;
    for (let index = 0; index < 64; index++) {
      const resourceId = await ctx.db.insert("legalResources", { ...resource, activeVersionId: undefined, catalogPublished: false });
      const versionId = await ctx.db.insert("documentVersions", { ...version, resourceId, geminiDocumentName: `${input.f.storeName}/documents/large${index}` });
      await ctx.db.patch(resourceId, { activeVersionId: versionId, catalogPublished: true });
    }
  });
  expect((await manifest(input)).stores[0].publicationFilter.documents).toHaveLength(65);
  expect(await input.t.run(ctx => readyStoreName(ctx, input.f.jurisdictionId))).toBe(input.f.storeName);
  await addition(input, "draft");
  expect((await manifest(input)).stores[0].publicationFilter.documents).toHaveLength(65);
  expect(await input.t.run(ctx => readyStoreName(ctx, input.f.jurisdictionId))).toBeNull();
});

it("projects current unpublished document counts separately from source authority", async () => {
  const input = await fixture();
  await addition(input, "draft"); await addition(input, "failed"); await addition(input, "publishing");
  const selection = await input.user.client.query(makeFunctionReference<"query">("jurisdictions:resolveResearchSelection"), { jurisdictionId: input.f.jurisdictionId });
  expect(selection.coverageWarning).toEqual({ excludedDocumentCount: 3 });
  const result = await manifest(input);
  expect(result.partialCoverage).toBe(false);
  expect(result.stores[0]).not.toHaveProperty("coverageWarning");
});

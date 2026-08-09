import test from "node:test";
import assert from "node:assert/strict";
import { extractMarketplaceSlug, findExactCurseforgeProject } from "../utils/marketplaceDownloads.js";

test("extractMarketplaceSlug accepts supported marketplace mod URLs", () => {
    assert.equal(extractMarketplaceSlug("https://modtale.net/mod/sentinel", "modtale"), "sentinel");
    assert.equal(extractMarketplaceSlug("https://www.modtale.net/mod/my-mod/", "modtale"), "my-mod");
    assert.equal(extractMarketplaceSlug("https://modifold.com/mod/example-project", "modifold"), "example-project");
    assert.equal(extractMarketplaceSlug("https://www.curseforge.com/hytale/mods/hyrestapi", "curseforge"), "hyrestapi");
});

test("extractMarketplaceSlug rejects unsupported or ambiguous URLs", () => {
    assert.equal(extractMarketplaceSlug("http://modtale.net/mod/sentinel", "modtale"), "");
    assert.equal(extractMarketplaceSlug("https://modtale.net/user/sentinel", "modtale"), "");
    assert.equal(extractMarketplaceSlug("https://example.com/mod/sentinel", "modtale"), "");
    assert.equal(extractMarketplaceSlug("https://modifold.com/mod/one/more", "modifold"), "");
    assert.equal(extractMarketplaceSlug("not a URL", "modifold"), "");
    assert.equal(extractMarketplaceSlug("https://www.curseforge.com/minecraft/mc-mods/hyrestapi", "curseforge"), "");
    assert.equal(extractMarketplaceSlug("https://example.com/hytale/mods/hyrestapi", "curseforge"), "");
    assert.equal(extractMarketplaceSlug("http://www.curseforge.com/hytale/mods/hyrestapi", "curseforge"), "");
    assert.equal(extractMarketplaceSlug("https://www.curseforge.com/hytale/mods/hyrestapi/files", "curseforge"), "");
});

test("findExactCurseforgeProject ignores fuzzy and non-Hytale search results", () => {
    const projects = [
        { id: 1, gameId: 70216, classId: 9137, slug: "hyrestapi-plus", downloadCount: 12 },
        { id: 2, gameId: 432, classId: 9137, slug: "hyrestapi", downloadCount: 20 },
        { id: 3, gameId: 70216, classId: 9185, slug: "hyrestapi", downloadCount: 30 },
        { id: 4, gameId: 70216, classId: 9137, slug: "HyRESTAPI", downloadCount: 154 }
    ];

    assert.equal(findExactCurseforgeProject(projects, "hyrestapi")?.id, 4);
    assert.equal(findExactCurseforgeProject(projects, "missing"), null);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(testDirectory, "..", "background.js"), "utf8");
const quickRateSource = fs.readFileSync(path.resolve(testDirectory, "..", "quick-rate.js"), "utf8");

function loadBackground({ permissionGranted = true, fetchImpl = fetch } = {}) {
  const calls = { injections: [], permissionRequests: [], tabMessages: [], tabsCreated: [] };
  let actionListener;
  let messageListener;

  const chrome = {
    action: { onClicked: { addListener(listener) { actionListener = listener; } } },
    runtime: {
      lastError: null,
      onMessage: { addListener(listener) { messageListener = listener; } }
    },
    scripting: {
      async executeScript(options) {
        calls.injections.push(options);
        if (options.func && String(options.func).includes("__professorInsightsAppV2")) return [{ result: true }];
        return [{ result: undefined }];
      }
    },
    permissions: {
      async contains() { return false; },
      async request(permission) { calls.permissionRequests.push(permission); return permissionGranted; }
    },
    storage: { local: { async get() { return {}; }, async set() {} } },
    tabs: {
      onRemoved: { addListener() {} },
      async create(options) { calls.tabsCreated.push(options); return { id: 99, ...options }; },
      sendMessage(...args) {
        calls.tabMessages.push(args.slice(0, 3));
        const callback = args.at(-1);
        if (typeof callback === "function") callback();
      }
    }
  };

  const context = vm.createContext({ chrome, console, URL, fetch: fetchImpl, AbortController, setTimeout, clearTimeout, Map, Set });
  context.importScripts = () => {};
  new vm.Script(quickRateSource).runInContext(context);
  new vm.Script(source).runInContext(context);
  return { calls, context, get actionListener() { return actionListener; }, get messageListener() { return messageListener; } };
}

function dispatchAsync(listener, message, sender = { tab: { id: 1 }, frameId: 0 }) {
  return new Promise((resolve) => listener(message, sender, resolve));
}

function dispatchIfHandled(listener, message, sender = { tab: { id: 1 }, frameId: 0 }) {
  return new Promise((resolve) => {
    let responded = false;
    const keepChannelOpen = listener(message, sender, (value) => {
      responded = true;
      resolve(value);
    });
    if (keepChannelOpen !== true && !responded) resolve(undefined);
  });
}

function dispatch(listener, message, sender) {
  let response;
  listener(message, sender, (value) => { response = value; });
  return response;
}

test("aggregates instructor context from top and child frames", async () => {
  const runtime = loadBackground();
  await runtime.actionListener({ id: 9, url: "https://myportal.calpoly.edu/student-center" });
  dispatch(runtime.messageListener, { type: "PI_DETECTOR_CONTEXT", context: { candidates: ["Bryce Jenkin"], courseCodes: ["MATH 221"] } }, { tab: { id: 9 }, frameId: 0 });
  dispatch(runtime.messageListener, { type: "PI_DETECTOR_CONTEXT", context: { candidates: ["Chris Carr"], courseCodes: ["BUS 304"] } }, { tab: { id: 9 }, frameId: 4 });

  const result = dispatch(runtime.messageListener, { type: "PI_GET_PAGE_CONTEXT" }, { tab: { id: 9 }, frameId: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.context.frameCount, 2);
  assert.deepEqual([...result.context.candidates], ["Bryce Jenkin", "Chris Carr"]);
  assert.deepEqual([...result.context.courseCodes], ["MATH 221", "BUS 304"]);
});

test("toolbar flow requests narrow portal access and injects the detector into every frame", async () => {
  const runtime = loadBackground();
  await runtime.actionListener({ id: 12, url: "https://myportal.calpoly.edu/student-center" });

  assert.deepEqual(JSON.parse(JSON.stringify(runtime.calls.permissionRequests)), [{ origins: ["https://cmsweb.pscs.calpoly.edu/*"] }]);
  const panelInjection = runtime.calls.injections.find((options) => options.files?.includes("content.js"));
  assert.deepEqual(JSON.parse(JSON.stringify(panelInjection.files)), ["quick-rate.js", "albums.js", "content.js"]);
  const detectorInjection = runtime.calls.injections.find((options) => options.files?.includes("detector.js"));
  assert.ok(detectorInjection);
  assert.equal(detectorInjection.target.tabId, 12);
  assert.equal(detectorInjection.target.allFrames, true);
});

test("page matching accepts middle initials and first-name initials", () => {
  const runtime = loadBackground();
  const middleInitialScore = vm.runInContext('scoreName("Doe, Jane A.", { firstName: "Jane", lastName: "Doe" })', runtime.context);
  const firstInitialScore = vm.runInContext('scoreName("Doe, J", { firstName: "Jane", lastName: "Doe" })', runtime.context);
  assert.ok(middleInitialScore >= 92);
  assert.ok(firstInitialScore >= 92);
});

test("permission denial is reported to the panel instead of looking like a parser failure", async () => {
  const runtime = loadBackground({ permissionGranted: false });
  await runtime.actionListener({ id: 14, url: "https://myportal.calpoly.edu/student-center" });
  assert.ok(runtime.calls.tabMessages.some(([, message]) => message.type === "PI_PORTAL_ACCESS_MISSING"));
});

test("Quick Rate resolves an exact Cal Poly RMP profile before opening its rating page", async () => {
  const store = {
    "U2Nob29sLTE1Mw==": { __typename: "School", legacyId: 153, name: "California Polytechnic State University" },
    teacher: {
      __typename: "Teacher",
      legacyId: 1353733,
      firstName: "Chris",
      lastName: "Carr",
      department: "Business Administration",
      school: { __ref: "U2Nob29sLTE1Mw==" }
    }
  };
  const html = `<script>window.__RELAY_STORE__ = ${JSON.stringify(store)};\nwindow.process = {};</script>`;
  const runtime = loadBackground({
    fetchImpl: async (url) => {
      assert.match(String(url), /search\/professors\/153\?q=Chris%20Carr$/);
      return { ok: true, status: 200, async text() { return html; } };
    }
  });

  const response = await dispatchAsync(runtime.messageListener, {
    type: "PI_OPEN_RMP_RATING",
    professor: { id: "poly-id", name: "Chris Carr", firstName: "Chris", lastName: "Carr", department: "BUS" },
    school: { id: "153", nodeId: "U2Nob29sLTE1Mw==", name: "California Polytechnic State University" }
  });

  assert.equal(response.ok, true);
  assert.equal(response.match, "exact");
  assert.equal(response.opened, true);
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.calls.tabsCreated)), [
    { url: "https://www.ratemyprofessors.com/add/professor-rating/1353733", active: true }
  ]);
});

test("Quick Rate does not open a same-name RMP professor from another school", async () => {
  const store = {
    "other-school": { __typename: "School", name: "Cuesta College" },
    teacher: {
      __typename: "Teacher",
      legacyId: 698955,
      firstName: "Bryce",
      lastName: "Jenkin",
      department: "Mathematics",
      school: { __ref: "other-school" }
    }
  };
  const html = `<script>window.__RELAY_STORE__ = ${JSON.stringify(store)};</script>`;
  const runtime = loadBackground({ fetchImpl: async () => ({ ok: true, status: 200, async text() { return html; } }) });

  const response = await dispatchAsync(runtime.messageListener, {
    type: "PI_OPEN_RMP_RATING",
    professor: { id: "poly-id", name: "Bryce Jenkin", firstName: "Bryce", lastName: "Jenkin", department: "MATH" },
    school: { id: "153", nodeId: "U2Nob29sLTE1Mw==", name: "California Polytechnic State University" }
  });

  assert.equal(response.ok, true);
  assert.equal(response.match, "not-found");
  assert.equal(response.opened, false);
  assert.deepEqual(runtime.calls.tabsCreated, []);
});

test("searches RMP schools and returns explicit campus choices", async () => {
  const store = {
    stanford: { __typename: "School", id: "U2Nob29sLTk1Mw==", legacyId: 953, name: "Stanford University", city: "Stanford", state: "CA" }
  };
  const html = `<script>window.__RELAY_STORE__ = ${JSON.stringify(store)};</script>`;
  const runtime = loadBackground({
    fetchImpl: async (url) => {
      assert.equal(String(url), "https://www.ratemyprofessors.com/search/schools?q=Stanford");
      return { ok: true, status: 200, async text() { return html; } };
    }
  });

  const response = await dispatchAsync(runtime.messageListener, { type: "PI_SEARCH_RMP_SCHOOLS", query: "Stanford" });
  assert.equal(response.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(response.schools)), [
    { id: "953", nodeId: "U2Nob29sLTk1Mw==", name: "Stanford University", city: "Stanford", state: "CA" }
  ]);
});

test("opens an exact professor at a user-selected non-Cal Poly school", async () => {
  const school = { id: "953", nodeId: "U2Nob29sLTk1Mw==", name: "Stanford University", city: "Stanford", state: "CA" };
  const store = {
    [school.nodeId]: { __typename: "School", id: school.nodeId, legacyId: 953, name: school.name },
    teacher: { __typename: "Teacher", legacyId: 1871927, firstName: "John", lastName: "Ousterhout", department: "Computer Science", school: { __ref: school.nodeId } }
  };
  const html = `<script>window.__RELAY_STORE__ = ${JSON.stringify(store)};</script>`;
  const runtime = loadBackground({
    fetchImpl: async (url) => {
      assert.equal(String(url), "https://www.ratemyprofessors.com/search/professors/953?q=John%20Ousterhout");
      return { ok: true, status: 200, async text() { return html; } };
    }
  });

  const response = await dispatchAsync(runtime.messageListener, {
    type: "PI_OPEN_RMP_RATING",
    professor: { id: "raw-page-name", name: "John Ousterhout" },
    school
  });
  assert.equal(response.ok, true);
  assert.equal(response.match, "exact");
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.calls.tabsCreated)), [
    { url: "https://www.ratemyprofessors.com/add/professor-rating/1871927", active: true }
  ]);
});

test("looks up Ilan Adler at Berkeley for display without opening an RMP tab", async () => {
  const school = {
    id: "1072",
    nodeId: "U2Nob29sLTEwNzI=",
    name: "University of California Berkeley",
    city: "Berkeley",
    state: "CA"
  };
  const store = {
    [school.nodeId]: {
      __typename: "School",
      id: school.nodeId,
      legacyId: 1072,
      name: school.name,
      city: school.city,
      state: school.state
    },
    "VGVhY2hlci02MzE5OTc=": {
      __typename: "Teacher",
      id: "VGVhY2hlci02MzE5OTc=",
      legacyId: 631997,
      firstName: "Ilan",
      lastName: "Adler",
      department: "Industrial Engineering",
      avgRating: 2.6,
      numRatings: 13,
      wouldTakeAgainPercent: 16.6667,
      avgDifficulty: 3.3,
      school: { __ref: school.nodeId }
    }
  };
  const html = `<script>window.__RELAY_STORE__ = ${JSON.stringify(store)};</script>`;
  let fetchCount = 0;
  const runtime = loadBackground({
    fetchImpl: async (url) => {
      fetchCount += 1;
      assert.equal(String(url), "https://www.ratemyprofessors.com/search/professors/1072?q=Ilan%20Adler");
      return { ok: true, status: 200, async text() { return html; } };
    }
  });

  const response = await dispatchIfHandled(runtime.messageListener, {
    type: "PI_LOOKUP_RMP_PROFESSOR",
    professor: { id: "candidate:ilan-adler", name: "Ilan Adler" },
    school
  });

  assert.equal(response?.ok, true);
  assert.equal(response.match, "exact");
  assert.equal(response.legacyId, "631997");
  assert.equal(response.avgRating, 2.6);
  assert.equal(response.numRatings, 13);
  assert.equal(response.wouldTakeAgainPercent, 16.6667);
  assert.equal(response.avgDifficulty, 3.3);
  assert.equal(response.profileUrl, "https://www.ratemyprofessors.com/professor/631997");
  assert.equal(fetchCount, 1);
  assert.deepEqual(runtime.calls.tabsCreated, []);
});

test("refuses Quick Rate when no school has been selected", async () => {
  let fetchCalled = false;
  const runtime = loadBackground({ fetchImpl: async () => { fetchCalled = true; throw new Error("should not fetch"); } });
  const response = await dispatchAsync(runtime.messageListener, {
    type: "PI_OPEN_RMP_RATING",
    professor: { name: "John Ousterhout" }
  });
  assert.equal(response.ok, false);
  assert.match(response.error, /Choose a school/);
  assert.equal(fetchCalled, false);
  assert.deepEqual(runtime.calls.tabsCreated, []);
});

test("never contacts PolyRatings when a non-Cal Poly school is selected", async () => {
  let fetchCount = 0;
  const runtime = loadBackground({
    fetchImpl: async () => {
      fetchCount += 1;
      throw new Error("PolyRatings must not be fetched for another school");
    }
  });
  const school = {
    id: "1072",
    nodeId: "U2Nob29sLTEwNzI=",
    name: "University of California Berkeley"
  };

  const search = await dispatchAsync(runtime.messageListener, {
    type: "PI_SEARCH",
    query: "Ilan Adler",
    school
  });
  const page = await dispatchAsync(runtime.messageListener, {
    type: "PI_LOOKUP_PAGE",
    candidates: ["Ilan Adler"],
    school
  });
  const details = await dispatchAsync(runtime.messageListener, {
    type: "PI_DETAILS",
    id: "fad73f10-0664-4df9-91f3-d91210f3a26b",
    school
  });

  assert.equal(fetchCount, 0);
  assert.equal(search.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(search.professors)), []);
  assert.equal(search.disabled, true);
  assert.match(search.source, /Rate My Professors/i);
  assert.equal(page.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(page.professors)), []);
  assert.equal(page.disabled, true);
  assert.equal(details.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(details.reviews)), []);
  assert.equal(details.disabled, true);
});

test("still enables PolyRatings for the selected Cal Poly school", async () => {
  let fetchCount = 0;
  const professors = Array.from({ length: 101 }, (_item, index) => ({
    id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
    firstName: index === 0 ? "Jane" : `Other${index}`,
    lastName: index === 0 ? "Doe" : "Professor",
    department: "TEST",
    courses: ["TEST 101"],
    overallRating: 3.5,
    numEvals: 1
  }));
  const runtime = loadBackground({
    fetchImpl: async (url) => {
      fetchCount += 1;
      assert.equal(String(url), "https://api-prod.polyratings.org/professors.all");
      return { ok: true, status: 200, async json() { return { result: { data: professors } }; } };
    }
  });

  const response = await dispatchAsync(runtime.messageListener, {
    type: "PI_SEARCH",
    query: "Jane Doe",
    school: { id: "153", nodeId: "U2Nob29sLTE1Mw==", name: "California Polytechnic State University" }
  });

  assert.equal(response.ok, true);
  assert.equal(fetchCount, 1);
  assert.equal(response.professors.length, 1);
  assert.equal(response.professors[0].name, "Jane Doe");
  assert.match(response.source, /PolyRatings/);
});

test("resolves detected page names only to exact same-school RMP profiles", async () => {
  const school = {
    id: "1072",
    nodeId: "U2Nob29sLTEwNzI=",
    name: "University of California Berkeley",
    city: "Berkeley",
    state: "CA"
  };
  const makeHtml = (...teachers) => `<script>window.__RELAY_STORE__ = ${JSON.stringify({
    [school.nodeId]: {
      __typename: "School",
      id: school.nodeId,
      legacyId: Number(school.id),
      name: school.name,
      city: school.city,
      state: school.state
    },
    ...Object.fromEntries(teachers.map((teacher, index) => [`teacher-${index}`, {
      __typename: "Teacher",
      ...teacher,
      school: { __ref: school.nodeId }
    }]))
  })};</script>`;
  let fetchCount = 0;
  const runtime = loadBackground({
    fetchImpl: async (url) => {
      fetchCount += 1;
      const value = String(url);
      if (value.endsWith("?q=Ilan%20Adler")) {
        return { ok: true, status: 200, async text() { return makeHtml({ legacyId: 631997, firstName: "Ilan", lastName: "Adler", department: "Industrial Engineering", avgRating: 2.6 }); } };
      }
      if (value.endsWith("?q=Alex%20Lee")) {
        return { ok: true, status: 200, async text() { return makeHtml(
          { legacyId: 1, firstName: "Alex", lastName: "Lee", department: "Art" },
          { legacyId: 2, firstName: "Alex", lastName: "Lee", department: "Biology" }
        ); } };
      }
      if (value.endsWith("?q=Missing%20Person")) {
        return { ok: true, status: 200, async text() { return makeHtml(); } };
      }
      throw new Error(`Unexpected RMP URL: ${value}`);
    }
  });

  const response = await dispatchAsync(runtime.messageListener, {
    type: "PI_LOOKUP_RMP_PAGE",
    candidates: ["Ilan Adler", "Ilan Adler", "Alex Lee", "Missing Person"],
    school
  });

  assert.equal(response.ok, true);
  assert.equal(fetchCount, 3);
  assert.equal(response.professors.length, 1);
  assert.equal(response.professors[0].legacyId, "631997");
  assert.equal(response.professors[0].name, "Ilan Adler");
  assert.equal(response.professors[0].school.id, "1072");
  assert.match(response.source, /Rate My Professors/i);
});

test("returns every PolyRatings review newest-first and caches the sanitized result", async () => {
  const professorId = "fad73f10-0664-4df9-91f3-d91210f3a26b";
  const longComment = `  ${"x".repeat(400)}\n${"y".repeat(100)}  `;
  let fetchCount = 0;
  const runtime = loadBackground({
    fetchImpl: async (url) => {
      fetchCount += 1;
      assert.match(String(url), /api-prod\.polyratings\.org\/professors\.get/);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            result: {
              data: {
                reviews: {
                  "CS 101": [
                    { postDate: "2024-01-10T00:00:00.000Z", rating: "  Older   comment  ", overallRating: 3.1 },
                    { postDate: "2026-02-10T00:00:00.000Z", rating: "Second newest", overallRating: 3.8 }
                  ],
                  "CS 202": [
                    { postDate: "2025-09-01T00:00:00.000Z", rating: "Middle review", overallRating: 3.5 },
                    { postDate: "2023-03-01T00:00:00.000Z", rating: "Oldest review", overallRating: 2.9 }
                  ],
                  "CS 303": [
                    { postDate: "2026-11-01T00:00:00.000Z", rating: longComment, overallRating: 4 }
                  ]
                }
              }
            }
          };
        }
      };
    }
  });
  const message = {
    type: "PI_DETAILS",
    id: professorId,
    school: { id: "153", nodeId: "U2Nob29sLTE1Mw==", name: "California Polytechnic State University" }
  };

  const first = await dispatchAsync(runtime.messageListener, message);
  const second = await dispatchAsync(runtime.messageListener, message);

  assert.equal(first.ok, true);
  assert.equal(fetchCount, 1);
  assert.equal(first.reviews.length, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(first.reviews.map((review) => review.course))), ["CS 303", "CS 101", "CS 202", "CS 101", "CS 202"]);
  assert.equal(first.reviews[0].rating, 4);
  assert.equal(first.reviews[0].text.length, 350);
  assert.doesNotMatch(first.reviews[0].text, /\s{2,}/);
  assert.equal(first.reviews[3].text, "Older comment");
  assert.deepEqual(JSON.parse(JSON.stringify(second.reviews)), JSON.parse(JSON.stringify(first.reviews)));
});

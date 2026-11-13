const API_ENDPOINT = "https://script.google.com/macros/s/AKfycbx1J_eqFZvUcCYBemVYJXrQ_M8SzwpFvm8Ey9_4AFle8AWtRpT03LMh3F83JoAVuXNU/exec";

// Toggle true for local Sandbox testing, false for production deployment
const IS_TESTING = false;
const TEST_STUDENT_ID = "3581201011";

/**
 * 1. TRIGGER ON LOGIN / BROWSER STARTUP
 */
chrome.runtime.onStartup.addListener(async () => {
  await syncFromApi();
  await evaluateAndApplyRules();
});

/**
 * 2. TRIGGER ON EXTENSION INSTALL / UPDATE
 */
chrome.runtime.onInstalled.addListener(async () => {
  await syncFromApi();
  await evaluateAndApplyRules();
  
  // Local schedule evaluation timer (Runs locally every 1 minute; 0 network calls)
  chrome.alarms.create("scheduleCheck", { periodInMinutes: 1 });
});

/**
 * 3. TRIGGER ON ACCOUNT SIGN-IN CHANGE
 */
if (chrome.identity && chrome.identity.onSignInChanged) {
  chrome.identity.onSignInChanged.addListener(async (account, signedIn) => {
    if (signedIn) {
      await syncFromApi();
      await evaluateAndApplyRules();
    }
  });
}

/**
 * Local alarm listener to evaluate schedules against the clock
 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "scheduleCheck") {
    await evaluateAndApplyRules();
  }
});

/**
 * Helper to acquire Chrome profile user info or return test mock
 */
function getUserInfo() {
  if (IS_TESTING) {
    return Promise.resolve({
      id: TEST_STUDENT_ID,
      email: TEST_STUDENT_ID + "@k12.hi.us"
    });
  }
  return new Promise((resolve) => {
    chrome.identity.getProfileUserInfo({ accountStatus: "ANY" }, (userInfo) => {
      resolve(userInfo);
    });
  });
}

/**
 * Fetch fresh student record from Google Apps Script / AppSheet API
 */
async function syncFromApi() {
  try {
    const userInfo = await getUserInfo();
    const userEmail = userInfo.email;

    if (!userEmail) {
      console.warn("No user email found.");
      return;
    }

    console.log(`Pulling fresh data on login for: ${userEmail}`);
    const response = await fetch(`${API_ENDPOINT}?email=${encodeURIComponent(userEmail)}`);
    const data = await response.json();
    console.log("Fresh response from API on login:", data);

    if (data && !data.error) {
      await chrome.storage.local.set({ studentData: data });
    } else {
      // DEFAULT SCENARIO: Student not in DB -> Clear local cached student record
      console.warn("API Error or Student Not Found in DB:", data?.error);
      await chrome.storage.local.remove("studentData");
    }
  } catch (error) {
    console.error("Error fetching student data from API:", error);
  }
}

/**
 * Central Rule Decision Logic (Scenarios 1-4)
 */
async function evaluateAndApplyRules() {
  try {
    const { studentData } = await chrome.storage.local.get("studentData");

    // DEFAULT SCENARIO: User does not exist in Student table -> Whitelisting/blocking ignored
    if (!studentData) {
      console.log("No student record found. Unblocking internet access completely.");
      await clearFilteringRules();
      return;
    }

		// CHECK: If "Whitelisting Active" is set to false/N/NO, unblock completely
    const activeVal = String(studentData["Whitelisting Active"] ?? "").trim().toUpperCase();
    const isWhitelistingInactive = studentData["Whitelisting Active"] === false || ["N", "NO", "FALSE"].includes(activeVal);

    if (isWhitelistingInactive) {
      console.log("Whitelisting is INACTIVE for this student. Unblocking internet access completely.");
      await clearFilteringRules();
      return;
    }

    const blockVal = String(studentData["Block Internet"] || "").trim().toUpperCase();
    const blockInternetOutside = studentData["Block Internet"] === true || ["Y", "YES", "TRUE"].includes(blockVal);
    const inFilterWindow = isInActiveFilterWindow(studentData);

    console.log(`In Filter Window: ${inFilterWindow} | Block Internet Outside: ${blockInternetOutside}`);

    if (inFilterWindow) {
      // INSIDE SCHEDULE WINDOW: Enforce domain whitelist filtering
      const allowedDomains = parseWhitelist(studentData.Whitelist);
      await updateFilteringRules(allowedDomains);
    } else {
      // OUTSIDE SCHEDULE WINDOW:
      if (blockInternetOutside) {
        // Block Internet = Y/TRUE -> Block ALL internet traffic
        await updateFilteringRules([]); 
      } else {
        // Block Internet = N/FALSE -> ALLOW ALL internet traffic (turn off filtering)
        await clearFilteringRules();
      }
    }
  } catch (error) {
    console.error("Error evaluating rules:", error);
  }
}

/**
 * Evaluates whether current time falls within student's active filter schedule
 */
function isInActiveFilterWindow(student) {
  if (!student) return false;

  const scheduledDays = student.Days || "";
  const activeDays = Array.isArray(scheduledDays) 
    ? scheduledDays.map(d => String(d).trim())
    : String(scheduledDays).split(",").map(d => d.trim()).filter(Boolean);

  // SCENARIO 1: User exists in DB but has NO days set -> Whitelisting active 24/7
  if (activeDays.length === 0) {
    return true;
  }

  const now = new Date();
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const todayAbbr = dayNames[now.getDay()]; // e.g. "Mon"

  // SCENARIO 2/3/4 EDGE CASE: If today is NOT checked in Days -> Filtering inactive
  if (!activeDays.includes(todayAbbr)) {
    return false;
  }

  // Today is checked in Days: Fetch Start and End times
  const startTimeStr = student[`${todayAbbr} Start`];
  const endTimeStr = student[`${todayAbbr} End`];

  const startMinutes = parseTimeToMinutes(startTimeStr);
  const endMinutes = parseTimeToMinutes(endTimeStr);

  // SCENARIO 2: Day is set, but NO start/end times set -> Active full 24 hours of this day
  if (startMinutes === null && endMinutes === null) {
    return true;
  }

  // SCENARIO 3/4 & PARTIAL TIMES: Time slot evaluation with cross-midnight support
  const start = startMinutes !== null ? startMinutes : 0;          // Midnight if start omitted
  const end = endMinutes !== null ? endMinutes : (24 * 60 - 1);    // 11:59 PM if end omitted
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  if (start <= end) {
    // Standard daytime window (e.g. 08:00 to 15:00)
    return currentMinutes >= start && currentMinutes <= end;
  } else {
    // Cross-midnight window (e.g. 22:00 to 02:00)
    return currentMinutes >= start || currentMinutes <= end;
  }
}

/**
 * Converts time strings ("08:00:00", "08:00", "8:00 AM", "15:30") to minutes from midnight
 */
function parseTimeToMinutes(timeStr) {
  if (!timeStr) return null;
  const str = String(timeStr).trim();

  // 12-hour AM/PM formats
  const ampmMatch = str.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)/i);
  if (ampmMatch) {
    let hours = parseInt(ampmMatch[1], 10);
    const minutes = parseInt(ampmMatch[2], 10);
    const period = ampmMatch[3].toUpperCase();

    if (period === "PM" && hours < 12) hours += 12;
    if (period === "AM" && hours === 12) hours = 0;

    return hours * 60 + minutes;
  }

  // 24-hour formats ("08:00:00" or "14:30")
  const parts = str.split(":");
  if (parts.length >= 2) {
    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);
    if (!isNaN(hours) && !isNaN(minutes)) {
      return hours * 60 + minutes;
    }
  }

  return null;
}

/**
 * Extracts and cleans domain list
 */
function parseWhitelist(whitelistRaw) {
  if (!whitelistRaw) return [];
  
  if (Array.isArray(whitelistRaw)) {
    return whitelistRaw.map(cleanDomain).filter(Boolean);
  }

  if (typeof whitelistRaw === "string") {
    return whitelistRaw
      .split(",")
      .map(cleanDomain)
      .filter(Boolean);
  }

  return [];
}

function cleanDomain(input) {
  if (!input) return "";
  let domain = String(input).trim().toLowerCase();
  
  domain = domain.replace(/^https?:\/\//, "");
  domain = domain.replace(/^\*\./, "");
  domain = domain.split("/")[0].split("?")[0];
  
  return domain;
}

/**
 * Removes all active dynamic filtering rules (Unblocks the browser completely)
 */
async function clearFilteringRules() {
  const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = currentRules.map((rule) => rule.id);
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: []
  });
}

/**
 * Updates Chrome declarativeNetRequest filtering rules for whitelisting or full blocking
 */
async function updateFilteringRules(allowedDomains) {
  const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = currentRules.map((rule) => rule.id);

  const addRules = [];
  const extensionId = chrome.runtime.id;

  // Rule 1: Redirect main frame navigations to blocked page
  addRules.push({
    id: 1,
    priority: 1,
    action: {
      type: "redirect",
      redirect: {
        regexSubstitution: `chrome-extension://${extensionId}/blocked.html?target=\\0`
      }
    },
    condition: {
      regexFilter: "^https?://.*",
      resourceTypes: ["main_frame"]
    }
  });

  // Rule 2: Block non-main-frame sub-resources by default
  addRules.push({
    id: 2,
    priority: 1,
    action: { type: "block" },
    condition: {
      urlFilter: "*",
      resourceTypes: [
        "sub_frame", "stylesheet", "script", "image",
        "font", "object", "xmlhttprequest", "ping",
        "media", "websocket", "other"
      ]
    }
  });

  // Essential infrastructure domains allowed at all times
  const infrastructureDomains = [
    "script.google.com",
    "script.googleusercontent.com",
    "accounts.google.com",
    "apis.google.com",
    "gstatic.com"
  ];

  let apiDomain = "";
  try {
    apiDomain = new URL(API_ENDPOINT).hostname;
  } catch (e) {}

  const fullWhitelist = Array.from(
    new Set([...allowedDomains, ...infrastructureDomains, apiDomain].map(cleanDomain).filter(Boolean))
  );

  let ruleIdCounter = 3;

  fullWhitelist.forEach((domain) => {
    const clean = cleanDomain(domain);
    if (!clean) return;

    // Rule A: Allow target domain requests
    addRules.push({
      id: ruleIdCounter++,
      priority: 2,
      action: { type: "allow" },
      condition: {
        urlFilter: `||${clean}^`,
        resourceTypes: [
          "main_frame", "sub_frame", "stylesheet", "script",
          "image", "font", "object", "xmlhttprequest", "ping",
          "media", "websocket", "other"
        ]
      }
    });

    // Rule B: Allow third-party sub-resources initiated by whitelisted domain
    addRules.push({
      id: ruleIdCounter++,
      priority: 2,
      action: { type: "allow" },
      condition: {
        initiatorDomains: [clean],
        resourceTypes: [
          "sub_frame", "stylesheet", "script", "image",
          "font", "object", "xmlhttprequest", "ping",
          "media", "websocket", "other"
        ]
      }
    });
  });

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules
  });
}
export { IUIndy };
import { storeFoodsInD1, storeMealsInD1, storeMetadataInD1 } from "@uplate/d1/index";
import { School, HallResult, HallData } from "@uplate/types/school";
import generalSchedules from "./generalSchedules.json";
import { Env } from "@uplate/types/env";
import { FoodItem } from "@uplate/types/foods";
import { MealItem } from "@uplate/types/meals";
import { Menu } from "@uplate/types/menu";

const SCHOOL_ID = "iu-indy";
const SCHOOL_GOV_CODE = 151111;
const TIME_ZONE = "America/New_York";
const MEAL_TIMES = ["Breakfast", "Lunch", "Dinner"];
const DINING_HALLS = ["Tower Dining"];

const HALL_LOCATIONS: Record<string, string> = {
  "Tower Dining": "5873e3933191a200e44efecf",
};

const HALL_METADATA: Record<
  string,
  { address: string; latitude: string; longitude: string }
> = {
  "Tower Dining": {
    address: "850 W Michigan St, Indianapolis, IN 46202",
    latitude: "39.7744",
    longitude: "-86.1755",
  },
};

function getTzOffset(date: string, timeZone: string): string {
  const ref = new Date(`${date}T12:00:00Z`);
  const utc = new Date(ref.toLocaleString("en-US", { timeZone: "UTC" }));
  const local = new Date(ref.toLocaleString("en-US", { timeZone }));
  const diff = (local.getTime() - utc.getTime()) / 60000;
  const sign = diff >= 0 ? "+" : "-";
  const h = String(Math.floor(Math.abs(diff) / 60)).padStart(2, "0");
  const m = String(Math.abs(diff) % 60).padStart(2, "0");
  return `${sign}${h}:${m}`;
}

function extractNutrient(nutrients: any[], pattern: RegExp): number | undefined {
  if (!nutrients || !Array.isArray(nutrients)) return undefined;
  const n = nutrients.find((entry: any) => pattern.test(String(entry.name || "")));
  if (!n) return undefined;
  const raw = n.valueNumeric != null ? n.valueNumeric : n.value;
  if (raw == null || raw === "" || raw === "-") return undefined;
  const num = parseFloat(String(raw));
  return Number.isNaN(num) ? undefined : num;
}

const CIPHERS = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-RSA-AES128-SHA",
  "ECDHE-RSA-AES256-SHA",
  "AES128-GCM-SHA256",
  "AES256-GCM-SHA384",
  "AES128-SHA",
  "AES256-SHA",
].join(":");

async function fetchDineOnCampusJson(url: string): Promise<any> {
  const g = globalThis as any;
  if (typeof g.process !== "undefined" && g.process?.versions?.node) {
    try {
      const httpsModule = "node:https";
      const zlibModule = "node:zlib";
      const https = await import(httpsModule);
      const zlib = await import(zlibModule);
      return await new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = https.default.request(
          {
            hostname: u.hostname,
            port: 443,
            path: u.pathname + u.search,
            method: "GET",
            ciphers: CIPHERS,
            headers: {
              "User-Agent":
              "BoilerFuel-Worker/1.0",
              Accept: "application/json, text/plain, */*",
              "Accept-Language": "en-US,en;q=0.5",
              "Accept-Encoding": "gzip, deflate, br",
              "Sec-Fetch-Dest": "empty",
              "Sec-Fetch-Mode": "cors",
              "Sec-Fetch-Site": "same-origin",
            },
          },
          (res: any) => {
            const chunks: any[] = [];
            res.on("data", (chunk: any) => chunks.push(chunk));
            res.on("end", () => {
              const buffer = g.Buffer.concat(chunks);
              const encoding = res.headers["content-encoding"];
              let text: string;
              try {
                if (encoding === "gzip") {
                  text = zlib.default.gunzipSync(buffer).toString("utf-8");
                } else if (encoding === "deflate") {
                  text = zlib.default.inflateSync(buffer).toString("utf-8");
                } else if (encoding === "br") {
                  text = zlib.default.brotliDecompressSync(buffer).toString("utf-8");
                } else {
                  text = buffer.toString("utf-8");
                }

                if (res.statusCode !== 200) {
                  return reject(
                    new Error(`HTTP ${res.statusCode}: ${text.slice(0, 100)}`),
                  );
                }
                resolve(JSON.parse(text));
              } catch (e) {
                reject(e);
              }
            });
          },
        );
        req.on("error", reject);
        req.end();
      });
    } catch {
      // Fall through to native fetch if dynamic import fails
    }
  }

  // Cloudflare Worker / edge environment: pure native fetch
  const res = await fetch(url, {
    headers: {
      "User-Agent":
              "BoilerFuel-Worker/1.0",
      Accept: "application/json, text/plain, */*",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

class IUIndy extends School {
  constructor() {
    super(SCHOOL_ID, DINING_HALLS, SCHOOL_GOV_CODE);
  }

  async processMenus(env: Env, dateOffset: number, isRecursive = false): Promise<boolean[][]> {
    const date = this.dateFromOffset(dateOffset, TIME_ZONE);
    let futures = DINING_HALLS.map(async (hall) => {
      const raw = await this.fetchAndParseHall(hall, date);
      return this.processAndStoreDiningCourtMenuData(env, hall, date, raw);
    });
    let responses = await Promise.all(futures);
    if (isRecursive) {
      console.log("Performing recursive fetch for next 2 days");
      for (const extra of [1, 2]) {
        const nextDate = this.dateFromOffset(dateOffset + extra, TIME_ZONE);
        const next = await Promise.all(
          DINING_HALLS.map(async (hall) => {
            const raw = await this.fetchAndParseHall(hall, nextDate);
            return this.processAndStoreDiningCourtMenuData(env, hall, nextDate, raw);
          }),
        );
        responses.push(...next);
      }
    }
    return responses;
  }

  async processAndStoreDiningCourtMenuData(env: Env, loc: string, date: string, hallData: HallData) {
    console.log(`Processing menu data for ${loc} on ${date}`);

    const { foods, meals, mealTimeHours } = hallData;

    if (foods.length > 0) {
      await storeFoodsInD1(env.DB, foods, SCHOOL_ID);
      console.log(`Stored ${foods.length} food items for ${loc}.`);
    }

    console.log(`Storing meal data for ${loc} on ${date} in D1.`);

    const updated = await Promise.all(
      MEAL_TIMES.map((mealTime) => {
        const menu: Menu = {
          diningHall: loc,
          date: date,
          meals: meals[mealTime] ?? [],
          school: SCHOOL_ID,
          mealTime: mealTime,
          mealTimeHours: mealTimeHours[mealTime] ?? "{}",
        };
        return storeMealsInD1(env, menu);
      }),
    );

    return updated;
  }

  parseItem(sourceItem: Record<string, any>, id: string): FoodItem | null {
    if (!sourceItem || !sourceItem.name) return null;

    const food: FoodItem = {
      id,
      name: String(sourceItem.name).trim(),
    };

    const calories =
      typeof sourceItem.calories === "number"
        ? sourceItem.calories
        : extractNutrient(sourceItem.nutrients, /^calories$/i);
    if (calories != null) food.calories = calories;

    const protein = extractNutrient(sourceItem.nutrients, /^protein/i);
    if (protein != null) food.protein = protein;

    const carbs = extractNutrient(sourceItem.nutrients, /^total carbohydrate|^carbohydrate/i);
    if (carbs != null) food.carbs = carbs;

    const totalFat = extractNutrient(sourceItem.nutrients, /^total fat/i);
    if (totalFat != null) food.totalFat = totalFat;

    const saturatedFat = extractNutrient(sourceItem.nutrients, /^saturated fat/i);
    if (saturatedFat != null) food.saturatedFat = saturatedFat;

    const sugar = extractNutrient(sourceItem.nutrients, /^sugar/i);
    if (sugar != null) food.sugar = sugar;

    const addedSugars = extractNutrient(sourceItem.nutrients, /^added sugar/i);
    if (addedSugars != null) food.addedSugars = addedSugars;

    const dietaryFiber = extractNutrient(sourceItem.nutrients, /^dietary fiber|^fiber/i);
    if (dietaryFiber != null) food.dietaryFiber = dietaryFiber;

    const sodium = extractNutrient(sourceItem.nutrients, /^sodium/i);
    if (sodium != null) food.sodium = sodium;

    const cholesterol = extractNutrient(sourceItem.nutrients, /^cholesterol/i);
    if (cholesterol != null) food.cholesterol = cholesterol;

    const calcium = extractNutrient(sourceItem.nutrients, /^calcium/i);
    if (calcium != null) food.calcium = calcium;

    const iron = extractNutrient(sourceItem.nutrients, /^iron/i);
    if (iron != null) food.iron = iron;

    const caloriesFromFat = extractNutrient(sourceItem.nutrients, /^calories from fat/i);
    if (caloriesFromFat != null) food.caloriesFromFat = caloriesFromFat;

    if (sourceItem.portion) {
      food.servingSize = String(sourceItem.portion).trim();
    }

    food.ingredients = sourceItem.ingredients ? String(sourceItem.ingredients).trim() : "";

    const labels: string[] = [];
    for (const f of sourceItem.filters || []) {
      const name = f?.name ?? f;
      if (typeof name === "string" && name.trim()) labels.push(name.trim());
    }
    for (const a of sourceItem.customAllergens || []) {
      const name = a?.name ?? a;
      if (typeof name === "string" && name.trim()) labels.push(name.trim());
    }
    food.labels = JSON.stringify([...new Set(labels)]);

    return food;
  }

  async pullRawData(date: string): Promise<HallResult[]> {
    const results = await Promise.allSettled(
      DINING_HALLS.map((hall) => this.fetchAndParseHall(hall, date)),
    );
    return results.map((r, i) =>
      r.status === "fulfilled"
        ? { ok: true as const, ...r.value }
        : { ok: false as const, hall: DINING_HALLS[i], error: String(r.reason) },
    );
  }

  private async fetchAndParseHall(loc: string, date: string): Promise<HallData> {
    const locationId = HALL_LOCATIONS[loc];
    if (!locationId) {
      throw new Error(`Unknown dining hall location: ${loc}`);
    }

    const periodsUrl = `https://apiv4.dineoncampus.com/locations/${locationId}/periods?date=${date}`;
    const periodsData = await fetchDineOnCampusJson(periodsUrl);
    const periodsList: any[] = periodsData?.periods ?? [];

    const meals: Record<string, MealItem[]> = {};
    for (const mt of MEAL_TIMES) {
      meals[mt] = [];
    }

    const mealTimeHours: Record<string, string> = {};
    const foodItemsMap = new Map<string, any>();

    const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const dayOfWeek = DAY_NAMES[new Date(`${date}T12:00:00Z`).getDay()];
    const tzOffset = getTzOffset(date, TIME_ZONE);

    for (const period of periodsList) {
      const periodName = String(period.name || "").trim();
      const matchedMeal = MEAL_TIMES.find(
        (mt) => mt.toLowerCase() === periodName.toLowerCase(),
      );

      if (!matchedMeal) continue;

      const sched = (generalSchedules as any)[loc]?.[matchedMeal]?.[dayOfWeek];
      if (sched?.Start && sched?.End) {
        mealTimeHours[matchedMeal] = JSON.stringify({
          Start: `${date}T${sched.Start}:00${tzOffset}`,
          End: `${date}T${sched.End}:00${tzOffset}`,
        });
      }

      const menuUrl = `https://apiv4.dineoncampus.com/locations/${locationId}/menu?date=${date}&period=${period.id}`;
      const menuData = await fetchDineOnCampusJson(menuUrl);
      const categories: any[] = menuData?.period?.categories ?? [];

      for (const category of categories) {
        const station = String(category.name || "Main").trim();
        for (const item of category.items ?? []) {
          const id = String(item.id);
          meals[matchedMeal].push({ id, station });
          if (!foodItemsMap.has(id)) {
            foodItemsMap.set(id, item);
          }
        }
      }
    }

    // Deduplicate meal items on id|station
    for (const mealName in meals) {
      const seen = new Map<string, MealItem>();
      for (const item of meals[mealName]) {
        const k = `${item.id}|${item.station}`;
        if (!seen.has(k)) seen.set(k, item);
      }
      meals[mealName] = Array.from(seen.values());
    }

    const foods: FoodItem[] = [];
    for (const [id, item] of foodItemsMap) {
      const parsed = this.parseItem(item, id);
      if (parsed) foods.push(parsed);
    }

    const meta = HALL_METADATA[loc] ?? { address: "", latitude: "", longitude: "" };
    const metadata = {
      address: meta.address,
      latitude: meta.latitude,
      longitude: meta.longitude,
      schedule: JSON.stringify((generalSchedules as Record<string, any>)[loc] ?? {}),
    };

    return { hall: loc, foods, meals, mealTimeHours, metadata };
  }

  async fetchMetadata(env: Env): Promise<void> {
    await Promise.all(
      DINING_HALLS.map(async (hall) => {
        const meta = HALL_METADATA[hall] ?? { address: "", latitude: "", longitude: "" };
        const schedule = JSON.stringify((generalSchedules as Record<string, any>)[hall] ?? {});

        await storeMetadataInD1(env.DB, {
          school: SCHOOL_ID,
          diningHall: hall,
          address: meta.address,
          latitude: meta.latitude,
          longitude: meta.longitude,
          type: "",
          schedule,
        });
      }),
    );
  }
}

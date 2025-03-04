/**
 * @fileoverview
 * AWS Lambda for an Alexa skill that provides weather-based clothing recommendations.
 * - Input: event.zip (ZIP code)
 * - Output: JSON with a spoken response and APL display data for Echo Show devices.
 */

// Configuration constants for triggering alerts
const THRESHOLDS = {
  // Temperature category difference required to generate an alert (0-7 scale)
  TEMP_CATEGORY_SWING: 2,

  // Precipitation amount in inches needed for "significant" alert
  SIGNIFICANT_PRECIPITATION: 0.25,

  // Minimal precipitation amount to mention in inches
  MINIMAL_PRECIPITATION: 0,

  // Wind speed in mph considered "high" (for alerts)
  HIGH_WIND_SPEED: 25,

  // How many hours ahead to check for high winds
  WIND_FORECAST_HOURS: 8,

  // Maximum statements to include in laterChanges summary
  MAX_LATER_STATEMENTS: 2,

  // Temperature thresholds for categories in Fahrenheit
  TEMP_THRESHOLDS: {
    EXTREME_COLD: 0,   // below 0°F
    VERY_COLD: 20,     // 0-20°F
    COLD: 35,          // 20-35°F
    COOL: 50,          // 35-50°F
    MILD: 65,          // 50-65°F
    WARM: 80,          // 65-80°F
    HOT: 90            // 80-90°F, above 90°F is "very hot"
  },

  // Wind adjustment thresholds and amounts (in °F)
  WIND_CHILL: {
    LIGHT: { threshold: 5, adjustment: 4 },    // 5-10 mph
    MODERATE: { threshold: 11, adjustment: 8 }, // 11-20 mph
    STRONG: { threshold: 21, adjustment: 12 },  // 21-30 mph
    SEVERE: { threshold: 30, adjustment: 18 }   // > 30 mph
  },

  // UV index thresholds
  UV: {
    MODERATE: 3,  // When to mention moderate UV protection
    HIGH: 6       // When to mention high UV protection
  }
};

/**
 * Main handler function to be exported for AWS Lambda.
 *
 * @async
 * @function handler
 * @param {Object} event - The event payload from Alexa, expected to contain { zip: string }
 * @returns {Promise<Object>} Returns an object with a statusCode and a JSON body containing { response, ... }
 */
export async function handler(event) {
  try {
      // 1) Extract ZIP code from the event
      const zipCode = event.queryStringParameters?.zip || "98102";

      // 2) Geocode: Convert ZIP to latitude/longitude via Open-Meteo's Geocoding API
      const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${zipCode}&count=1&language=en&format=json`;
      const geoResponse = await fetch(geoUrl);
      const geoData = await geoResponse.json();

      if (!geoData || !geoData.results || !geoData.results.length) {
          throw new Error("Could not find lat/long for that ZIP code.");
      }
      const { latitude, longitude, name } = geoData.results[0];

      // 3) Fetch weather from Open-Meteo (current + hourly + daily sunrise/sunset)
      // UPDATED: Added temperature_unit=fahrenheit to get Fahrenheit values directly
      const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}`
          + `&hourly=temperature_2m,relativehumidity_2m,precipitation,windspeed_10m,weathercode`
          + `&daily=uv_index_max,sunrise,sunset&current_weather=true&timezone=auto`
          + `&temperature_unit=fahrenheit&windspeed_unit=mph&precipitation_unit=inch`;
      const weatherResponse = await fetch(weatherUrl);
      const weatherData = await weatherResponse.json();

      if (!weatherData || !weatherData.current_weather) {
          throw new Error("No current_weather data from Open-Meteo.");
      }

      // 4) Parse the current conditions
      const {
          temperature: currentTemp, // Now in Fahrenheit from API
          windspeed: currentWind,   // Now in mph from API
          time: currentTime,
          weathercode: currentWeatherCode
      } = weatherData.current_weather;

      // 5) Find matching index in hourly arrays to get humidity & precipitation
      const hourlyTimes = weatherData.hourly.time || [];

      // Create currentTimeObj once
      const currentTimeObj = new Date(currentTime);

      // Find the closest hour in the weather data
      let idx = -1;
      for (let i = 0; i < hourlyTimes.length; i++) {
          const hourlyTime = new Date(hourlyTimes[i]);
          // Find the closest hour (same day, closest or equal hour)
          if (hourlyTime.getDate() === currentTimeObj.getDate() &&
              hourlyTime.getMonth() === currentTimeObj.getMonth() &&
              hourlyTime.getFullYear() === currentTimeObj.getFullYear() &&
              hourlyTime.getHours() <= currentTimeObj.getHours()) {
              idx = i;
              // If exact hour match, break
              if (hourlyTime.getHours() === currentTimeObj.getHours()) {
                  break;
              }
          }
      }

      // If we've passed the last hour of the day, use the last hour
      if (idx === -1 && hourlyTimes.length > 0) {
          // Find the last hour from yesterday or earlier today
          for (let i = hourlyTimes.length - 1; i >= 0; i--) {
              const hourlyTime = new Date(hourlyTimes[i]);
              if (hourlyTime <= currentTimeObj) {
                  idx = i;
                  break;
              }
          }
      }

      console.log(`Current time: ${currentTime}, matched to hourly index: ${idx}, time: ${idx >= 0 ? hourlyTimes[idx] : 'none'}`);

      const currentHumidity = (idx >= 0)
          ? weatherData.hourly.relativehumidity_2m[idx]
          : 50; // fallback
      const currentPrecip = (idx >= 0)
          ? weatherData.hourly.precipitation[idx]
          : 0;  // fallback

      // 6) Get daily max UV index and sunrise/sunset times
      const uvMax = (weatherData.daily && weatherData.daily.uv_index_max)
          ? weatherData.daily.uv_index_max[0]
          : 3; // fallback

      const sunrise = (weatherData.daily && weatherData.daily.sunrise)
          ? weatherData.daily.sunrise[0]
          : null;
      const sunset = (weatherData.daily && weatherData.daily.sunset)
          ? weatherData.daily.sunset[0]
          : null;

      // 7) Determine if current time is considered daytime (between sunrise & sunset)
      // currentTimeObj is already defined above
      const isDaytime = isTimeBetween(currentTimeObj, sunrise ? new Date(sunrise) : null, sunset ? new Date(sunset) : null);

      // 8) Convert the WMO weather code to a human-readable description
      const weatherDescription = getWeatherDescription(currentWeatherCode);

      // 9) Compute "effective" temperature (wind chill + humidity adjustments)
      const nowEff = computeEffectiveTemp(currentTemp, currentWind, currentHumidity);

      // 10) Generate clothing advice for now
      const nowRecommendation = getClothingRecommendation(
          nowEff,
          currentPrecip,
          currentWind,
          currentHumidity,
          uvMax,
          weatherDescription,
          isDaytime
      );

      // 11) Check the rest of today for big changes
      const laterSummary = analyzeLaterToday(idx, nowEff, weatherData);

      // 12) Generate APL visual content
      const visualData = generateAPLData(
          weatherDescription,
          nowEff,
          currentPrecip,
          currentWind,
          currentHumidity,
          uvMax,
          isDaytime
      );

      // 13) Construct a spoken response for Alexa (omitting the ZIP code)
      let spokenResponse = `It's about ${Math.round(currentTemp)} degrees right now with ${weatherDescription.toLowerCase()} conditions. ${nowRecommendation}`;
      if (laterSummary) {
          spokenResponse += ` ${laterSummary}`;
      }

      // Return as JSON
      return {
          statusCode: 200,
          body: JSON.stringify({
              response: spokenResponse,       // The Alexa speech
              temperature: Math.round(currentTemp),
              weatherDescription,
              recommendation: nowRecommendation,
              laterChanges: laterSummary,
              locationName: name,
              apl: visualData,                // APL data for Echo Show
              diagnostics: {
                  currentEffectiveTemp: nowEff,
                  currentCategory: getTempCategory(nowEff),
                  currentCategoryIndex: categoryIndex(getTempCategory(nowEff)),
                  currentTime: currentTime,
                  hourlyTimesLength: weatherData.hourly.time?.length || 0,
                  currentTimeIdx: idx,
                  startDate: currentTimeObj.toISOString(),
                  hourlyTimeStart: weatherData.hourly.time?.[0] || "none",
                  hourlyTimeEnd: weatherData.hourly.time?.[weatherData.hourly.time.length-1] || "none",
                  laterAnalysis: getLaterAnalysisDetails(idx, weatherData, nowEff)
              }
          })
      };

  } catch (err) {
      console.error(err);
      // Error fallback response
      return {
          statusCode: 500,
          body: JSON.stringify({
              response: "Sorry, I had trouble getting the weather information for that location."
          })
      };
  }
}

/**
 * Determines whether the current time is between two other Date objects (e.g. sunrise & sunset).
 * Open-Meteo provides times in the requested timezone, so direct comparison is safe.
 *
 * @function isTimeBetween
 * @param {Date} currentTime - The current time
 * @param {Date|null} sunrise - Sunrise time
 * @param {Date|null} sunset - Sunset time
 * @returns {boolean} True if currentTime is between sunrise and sunset, otherwise false
 */
function isTimeBetween(currentTime, sunrise, sunset) {
  if (!sunrise || !sunset) {
      // If we can't parse sunrise/sunset, default to true (daytime).
      return true;
  }
  return currentTime >= sunrise && currentTime <= sunset;
}

/**
 * Converts a WMO weather code into a human-readable description.
 * Reference: https://www.nodc.noaa.gov/archive/arc0021/0002199/1.1/data/0-data/HTML/WMO-CODE/WMO4677.HTM
 *
 * @function getWeatherDescription
 * @param {number} code - The numeric WMO weather code
 * @returns {string} A short text describing the weather (e.g. "Light Rain", "Thunderstorm")
 */
function getWeatherDescription(code) {
  const weatherMap = {
      0: "Clear Sky",
      1: "Mainly Clear",
      2: "Partly Cloudy",
      3: "Overcast",
      45: "Foggy",
      48: "Foggy with Rime",
      51: "Light Drizzle",
      53: "Moderate Drizzle",
      55: "Heavy Drizzle",
      56: "Light Freezing Drizzle",
      57: "Dense Freezing Drizzle",
      61: "Light Rain",
      63: "Moderate Rain",
      65: "Heavy Rain",
      66: "Light Freezing Rain",
      67: "Heavy Freezing Rain",
      71: "Light Snow",
      73: "Moderate Snow",
      75: "Heavy Snow",
      77: "Snow Grains",
      80: "Light Rain Showers",
      81: "Moderate Rain Showers",
      82: "Violent Rain Showers",
      85: "Light Snow Showers",
      86: "Heavy Snow Showers",
      95: "Thunderstorm",
      96: "Thunderstorm with Light Hail",
      99: "Thunderstorm with Heavy Hail"
  };
  return weatherMap[code] || "Mixed Conditions";
}

/**
 * Computes an approximate effective temperature (°F) by applying a basic wind chill and humidity factor.
 * All values are already in Fahrenheit from the API.
 *
 * @function computeEffectiveTemp
 * @param {number} tempF - The raw temperature in Fahrenheit
 * @param {number} windMph - The windspeed in mph
 * @param {number} humidity - Relative humidity as a percentage
 * @returns {number} An adjusted "effective" temperature in °F
 */
function computeEffectiveTemp(tempF, windMph, humidity) {
  let eff = tempF;

  // Wind chill approximations using constants
  if (windMph >= THRESHOLDS.WIND_CHILL.LIGHT.threshold &&
      windMph < THRESHOLDS.WIND_CHILL.MODERATE.threshold) {
      eff -= THRESHOLDS.WIND_CHILL.LIGHT.adjustment;
  } else if (windMph >= THRESHOLDS.WIND_CHILL.MODERATE.threshold &&
             windMph < THRESHOLDS.WIND_CHILL.STRONG.threshold) {
      eff -= THRESHOLDS.WIND_CHILL.MODERATE.adjustment;
  } else if (windMph >= THRESHOLDS.WIND_CHILL.STRONG.threshold &&
             windMph < THRESHOLDS.WIND_CHILL.SEVERE.threshold) {
      eff -= THRESHOLDS.WIND_CHILL.STRONG.adjustment;
  } else if (windMph >= THRESHOLDS.WIND_CHILL.SEVERE.threshold) {
      eff -= THRESHOLDS.WIND_CHILL.SEVERE.adjustment;
  }

  // Humidity: if hot + high humidity => feels hotter, if cold + very low humidity => feels colder
  if (tempF > 70 && humidity > 70) {
      eff += 8;
  } else if (tempF < 50 && humidity < 30) {
      eff -= 3;
  }

  return eff;
}

/**
 * Analyzes the forecast for the rest of today, checking for:
 * - Big category swings (≥ THRESHOLDS.TEMP_CATEGORY_SWING levels different from now)
 * - Notable precipitation (> THRESHOLDS.SIGNIFICANT_PRECIPITATION)
 * - High wind (> THRESHOLDS.HIGH_WIND_SPEED) in the next THRESHOLDS.WIND_FORECAST_HOURS hours
 * Returns a short summary string if changes are found.
 *
 * @function analyzeLaterToday
 * @param {number} startIndex - The hourly array index corresponding to the current time
 * @param {number} nowEff - The current effective temperature
 * @param {Object} weatherData - The entire weather JSON from Open-Meteo
 * @returns {string} A short string describing later changes, or an empty string if none
 */
function analyzeLaterToday(startIndex, nowEff, weatherData) {
  const hourlyTimes = weatherData.hourly.time || [];

  // Log for debugging
  console.log(`analyzeLaterToday: startIndex=${startIndex}, hourlyTimes.length=${hourlyTimes.length}`);

  if (!hourlyTimes.length || startIndex < 0) {
    console.log('Early return: invalid array or startIndex');
    return "";
  }

  const hourlyTemps = weatherData.hourly.temperature_2m || [];
  const hourlyWinds = weatherData.hourly.windspeed_10m || [];
  const hourlyHumids = weatherData.hourly.relativehumidity_2m || [];
  const hourlyPrecips = weatherData.hourly.precipitation || [];
  const hourlyCodes = weatherData.hourly.weathercode || [];

  // Category info for "now"
  const currentCategory = getTempCategory(nowEff);
  const currentCatIndex = categoryIndex(currentCategory);

  // Check if we have any future times in the same day
  const nowDate = new Date(hourlyTimes[startIndex]);
  let hasFutureHoursToday = false;

  for (let i = startIndex + 1; i < hourlyTimes.length; i++) {
    const t = new Date(hourlyTimes[i]);
    if (t.getDate() === nowDate.getDate()) {
      hasFutureHoursToday = true;
      break;
    }
  }

  if (!hasFutureHoursToday) {
    console.log(`No future hours left in today. Current date: ${nowDate.toISOString()}`);
    return "";
  }

  console.log(`Analyzing forecast for rest of ${nowDate.toDateString()}`);
  const statements = [];

  // Track conditions already notified to avoid repeating
  const notifiedConditions = {
    tempSwing: false,
    precipitation: false,
    wind: false
  };

  // Scan upcoming hours until midnight local time
  for (let i = startIndex + 1; i < hourlyTimes.length; i++) {
    const t = new Date(hourlyTimes[i]);
    // Stop if we cross into the next day
    if (t.getDate() !== nowDate.getDate()) {
      console.log(`Breaking loop at index ${i}, date changed to ${t.toDateString()}`);
      break;
    }

    const rawTemp = hourlyTemps[i];
    const wind = hourlyWinds[i];
    const hum = hourlyHumids[i];
    const prec = hourlyPrecips[i];
    const code = hourlyCodes[i];

    const eff = computeEffectiveTemp(rawTemp, wind, hum);
    const cat = getTempCategory(eff);
    const catIdx = categoryIndex(cat);

    const hourLog = {
      time: formatHour(t),
      rawTemp,
      effectiveTemp: eff,
      category: cat,
      catDiff: Math.abs(catIdx - currentCatIndex),
      wind,
      precip: prec
    };
    console.log(`Hour analysis: ${JSON.stringify(hourLog)}`);

    // 1) Big temp category swing (using THRESHOLDS.TEMP_CATEGORY_SWING)
    if (!notifiedConditions.tempSwing &&
        Math.abs(catIdx - currentCatIndex) >= THRESHOLDS.TEMP_CATEGORY_SWING) {
      statements.push(`Around ${formatHour(t)}, it may feel ${cat}. ${shortAdviceForCategory(cat)}`);
      notifiedConditions.tempSwing = true;
      console.log(`Temperature swing detected at ${formatHour(t)}: ${currentCategory} → ${cat}`);
    }

    // 2) Precipitation (using THRESHOLDS.SIGNIFICANT_PRECIPITATION)
    if (!notifiedConditions.precipitation && prec > THRESHOLDS.SIGNIFICANT_PRECIPITATION) {
      const futureDesc = getWeatherDescription(code).toLowerCase();
      statements.push(`Expect ${futureDesc} near ${formatHour(t)}, so bring rain gear.`);
      notifiedConditions.precipitation = true;
      console.log(`Precipitation event detected at ${formatHour(t)}: ${prec} inches`);
    }

    // 3) High wind (using THRESHOLDS.HIGH_WIND_SPEED and THRESHOLDS.WIND_FORECAST_HOURS)
    if (!notifiedConditions.wind &&
        wind > THRESHOLDS.HIGH_WIND_SPEED &&
        i <= startIndex + THRESHOLDS.WIND_FORECAST_HOURS) {
      statements.push(`Strong winds expected around ${formatHour(t)}, consider wind protection.`);
      notifiedConditions.wind = true;
      console.log(`High wind detected at ${formatHour(t)}: ${wind} mph`);
    }
  }

  if (!statements.length) {
    console.log('No significant weather changes detected for today');
    return "";
  }

  // Keep it concise by limiting statements (using THRESHOLDS.MAX_LATER_STATEMENTS)
  if (statements.length > THRESHOLDS.MAX_LATER_STATEMENTS) {
    console.log(`Limiting from ${statements.length} statements to ${THRESHOLDS.MAX_LATER_STATEMENTS}`);
    statements.splice(THRESHOLDS.MAX_LATER_STATEMENTS);
  }

  const result = `Later today, watch for changes. ${statements.join(" ")}`;
  console.log(`Final laterSummary: "${result}"`);
  return result;
}

/**
 * Helper function to get detailed analysis info for diagnostics
 *
 * @function getLaterAnalysisDetails
 * @param {number} startIndex - The hourly array index corresponding to the current time
 * @param {Object} weatherData - The entire weather JSON from Open-Meteo
 * @param {number} nowEff - The current effective temperature
 * @returns {Array} Array of objects with hourly analysis details
 */
function getLaterAnalysisDetails(startIndex, weatherData, nowEff) {
  const hourlyTimes = weatherData.hourly.time || [];
  if (!hourlyTimes.length || startIndex < 0) return [];

  const hourlyTemps = weatherData.hourly.temperature_2m || [];
  const hourlyWinds = weatherData.hourly.windspeed_10m || [];
  const hourlyHumids = weatherData.hourly.relativehumidity_2m || [];
  const hourlyPrecips = weatherData.hourly.precipitation || [];
  const hourlyCodes = weatherData.hourly.weathercode || [];

  const currentCategory = getTempCategory(nowEff);
  const currentCatIndex = categoryIndex(currentCategory);
  const nowDate = new Date(hourlyTimes[startIndex]);

  // Build detailed analysis for each hour
  const hourlyAnalysis = [];

  for (let i = startIndex + 1; i < hourlyTimes.length; i++) {
      const t = new Date(hourlyTimes[i]);
      if (t.getDate() !== nowDate.getDate()) break;

      const rawTemp = hourlyTemps[i];
      const wind = hourlyWinds[i];
      const hum = hourlyHumids[i];
      const prec = hourlyPrecips[i];
      const code = hourlyCodes[i];
      const eff = computeEffectiveTemp(rawTemp, wind, hum);
      const cat = getTempCategory(eff);
      const catIdx = categoryIndex(cat);

      hourlyAnalysis.push({
          time: hourlyTimes[i],
          formattedTime: formatHour(t),
          rawTemp,
          effectiveTemp: eff,
          category: cat,
          categoryIndex: catIdx,
          categoryDifference: Math.abs(catIdx - currentCatIndex),
          windSpeed: wind,
          humidity: hum,
          precipitation: prec,
          weatherCode: code,
          weatherDescription: getWeatherDescription(code),
          triggers: {
              tempSwing: Math.abs(catIdx - currentCatIndex) >= THRESHOLDS.TEMP_CATEGORY_SWING,
              precipitation: prec > THRESHOLDS.SIGNIFICANT_PRECIPITATION,
              wind: wind > THRESHOLDS.HIGH_WIND_SPEED && i <= startIndex + THRESHOLDS.WIND_FORECAST_HOURS
          }
      });
  }

  return hourlyAnalysis;
}

/**
 * Converts an effective temperature into one of eight categories:
 * "extreme cold", "very cold", "cold", "cool", "mild", "warm", "hot", "very hot".
 *
 * @function getTempCategory
 * @param {number} effTemp - The effective temperature (°F)
 * @returns {string} The category
 */
function getTempCategory(effTemp) {
  if (effTemp < THRESHOLDS.TEMP_THRESHOLDS.EXTREME_COLD) return "extreme cold";
  if (effTemp < THRESHOLDS.TEMP_THRESHOLDS.VERY_COLD) return "very cold";
  if (effTemp < THRESHOLDS.TEMP_THRESHOLDS.COLD) return "cold";
  if (effTemp < THRESHOLDS.TEMP_THRESHOLDS.COOL) return "cool";
  if (effTemp < THRESHOLDS.TEMP_THRESHOLDS.MILD) return "mild";
  if (effTemp < THRESHOLDS.TEMP_THRESHOLDS.WARM) return "warm";
  if (effTemp < THRESHOLDS.TEMP_THRESHOLDS.HOT) return "hot";
  return "very hot";
}

/**
 * Returns an integer index for each category so we can compare how 'far apart' two categories are.
 *
 * @function categoryIndex
 * @param {string} category - A category name
 * @returns {number} An integer index
 */
function categoryIndex(category) {
  const categories = [
      "extreme cold",
      "very cold",
      "cold",
      "cool",
      "mild",
      "warm",
      "hot",
      "very hot"
  ];
  return categories.indexOf(category);
}

/**
 * Generates the main recommendation string for current conditions.
 * Factors in category, precipitation, specific weather descriptions, wind, humidity, and UV.
 *
 * @function getClothingRecommendation
 * @param {number} effTemp - Effective temperature
 * @param {number} precip - Precipitation rate
 * @param {number} windSpeed - Windspeed in mph
 * @param {number} humidity - Relative humidity
 * @param {number} uvIndex - Daily max UV index
 * @param {string} weatherDesc - Weather description (e.g. "Light Rain", "Thunderstorm")
 * @param {boolean} isDaytime - Whether current time is between sunrise and sunset
 * @returns {string} A concise recommendation string
 */
function getClothingRecommendation(effTemp, precip, windSpeed, humidity, uvIndex, weatherDesc, isDaytime) {
  const cat = getTempCategory(effTemp);

  // Base advice for each category
  const baseAdviceMap = {
      "extreme cold": "Wear heavy layers, insulated boots, and cover exposed skin.",
      "very cold": "Thermal base layers, heavy coat, gloves, and a warm hat.",
      "cold": "Layers plus a warm sweater and winter jacket.",
      "cool": "Long sleeves and a jacket or hoodie.",
      "mild": "A light jacket or long-sleeve shirt.",
      "warm": "Short sleeves or thin layers; maybe sunglasses.",
      "hot": "Lightweight clothes; stay hydrated.",
      "very hot": "Minimal, breathable clothing and strong sun protection."
  };
  let advice = baseAdviceMap[cat] || "Dress comfortably.";

  // Precip check (using threshold constants)
  if (precip > THRESHOLDS.SIGNIFICANT_PRECIPITATION) {
      advice += " Bring a waterproof layer.";
  } else if (precip > THRESHOLDS.MINIMAL_PRECIPITATION) {
      advice += " Consider a light rain jacket.";
  }

  // Special conditions for certain weather codes
  if (weatherDesc.includes("Snow")) {
      advice += " Waterproof boots are recommended.";
  } else if (weatherDesc.includes("Thunderstorm")) {
      advice += " Stay safe and avoid open areas.";
  } else if (weatherDesc.includes("Fog")) {
      advice += " Wear bright clothing for visibility.";
  }

  // Wind + cold
  if (windSpeed > 10 && effTemp < THRESHOLDS.TEMP_THRESHOLDS.COOL) {
      advice += " A windproof coat helps.";
  }

  // High humidity + warm
  if (humidity > 70 && effTemp > 70) {
      advice += " Moisture-wicking fabric is good in humidity.";
  }

  // UV mention only if it's daytime (using UV threshold constants)
  if (isDaytime) {
      if (uvIndex >= THRESHOLDS.UV.HIGH) {
          advice += " UV is high, wear sunscreen and a hat.";
      } else if (uvIndex >= THRESHOLDS.UV.MODERATE) {
          advice += " Moderate UV, consider sun protection.";
      }
  }

  return `It feels ${cat}. ${advice}`;
}

/**
 * Provides a short piece of advice if there's a big temperature swing later in the day.
 *
 * @function shortAdviceForCategory
 * @param {string} cat - The temperature category (e.g. "cold", "hot")
 * @returns {string} Concise extra advice for that category
 */
function shortAdviceForCategory(cat) {
  const shortMap = {
      "extreme cold": "Bundle up with multiple insulating layers.",
      "very cold": "Heavy coat, thermal layers, winter gear.",
      "cold": "Wear a warm jacket and layers.",
      "cool": "A light jacket or hoodie should help.",
      "mild": "Light layers are likely enough.",
      "warm": "Short sleeves or light clothing.",
      "hot": "Thin, breathable clothes, stay hydrated.",
      "very hot": "Minimal clothing and strong sun protection."
  };
  return shortMap[cat] || "";
}

/**
 * Formats a Date object into 12-hour style with AM/PM (e.g. "3 PM").
 *
 * @function formatHour
 * @param {Date} dateObj - The Date to format
 * @returns {string} A string in the format "H AM/PM"
 */
function formatHour(dateObj) {
  let hour = dateObj.getHours();
  const ampm = hour >= 12 ? "PM" : "AM";
  if (hour === 0) hour = 12;
  else if (hour > 12) hour -= 12;
  return `${hour} ${ampm}`;
}

/**
 * Generates data for Alexa Presentation Language (APL) display on Echo Show devices.
 *
 * @function generateAPLData
 * @param {string} weatherDesc - Weather description
 * @param {number} effTemp - Effective temperature (°F)
 * @param {number} precip - Precipitation amount
 * @param {number} windSpeed - Wind speed in mph
 * @param {number} humidity - Humidity percentage
 * @param {number} uvIndex - UV index value
 * @param {boolean} isDaytime - Whether it's daytime
 * @returns {Object} Object with background and clothing recommendation data for APL
 */
function generateAPLData(weatherDesc, effTemp, precip, windSpeed, humidity, uvIndex, isDaytime) {
  // 1. Determine background image based on weather conditions and time of day
  let backgroundType = "sunny";

  if (weatherDesc.includes("Rain") || weatherDesc.includes("Drizzle")) {
    backgroundType = "rainy";
  } else if (weatherDesc.includes("Snow")) {
    backgroundType = "snowy";
  } else if (weatherDesc.includes("Cloud") || weatherDesc.includes("Overcast")) {
    backgroundType = "overcast";
  } else if (weatherDesc.includes("Fog")) {
    backgroundType = "foggy";
  } else if (weatherDesc.includes("Thunder")) {
    backgroundType = "stormy";
  } else if (!isDaytime) {
    backgroundType = "night";
  }

  // 2. Determine clothing recommendations with emojis
  const clothingItems = [];
  const tempCategory = getTempCategory(effTemp);

  // Temperature-based clothing
  if (tempCategory === "extreme cold" || tempCategory === "very cold" || tempCategory === "cold") {
    clothingItems.push({
      item: "Heavy Coat",
      emoji: "🧥"
    });
    clothingItems.push({
      item: "Winter Hat",
      emoji: "🧢"
    });
    clothingItems.push({
      item: "Gloves",
      emoji: "🧤"
    });
    clothingItems.push({
      item: "Long Pants",
      emoji: "👖"
    });
  } else if (tempCategory === "cool") {
    clothingItems.push({
      item: "Light Jacket",
      emoji: "🧥"
    });
    clothingItems.push({
      item: "Long Pants",
      emoji: "👖"
    });
  } else if (tempCategory === "mild") {
    clothingItems.push({
      item: "Long Sleeve",
      emoji: "👕"
    });
    clothingItems.push({
      item: "Long Pants",
      emoji: "👖"
    });
  } else if (tempCategory === "warm" || tempCategory === "hot") {
    clothingItems.push({
      item: "T-Shirt",
      emoji: "👕"
    });
    clothingItems.push({
      item: "Shorts",
      emoji: "🩳"
    });
  } else if (tempCategory === "very hot") {
    clothingItems.push({
      item: "Light Clothes",
      emoji: "👕"
    });
    clothingItems.push({
      item: "Shorts",
      emoji: "🩳"
    });
    clothingItems.push({
      item: "Hydration",
      emoji: "💧"
    });
  }

  // Weather-specific items
  if (precip > THRESHOLDS.MINIMAL_PRECIPITATION) {
    clothingItems.push({
      item: "Umbrella",
      emoji: "☂️"
    });
    clothingItems.push({
      item: "Rain Jacket",
      emoji: "🧥"
    });
  }

  if (weatherDesc.includes("Snow")) {
    clothingItems.push({
      item: "Snow Boots",
      emoji: "👢"
    });
  }

  if (isDaytime && uvIndex >= THRESHOLDS.UV.MODERATE) {
    clothingItems.push({
      item: "Sunglasses",
      emoji: "🕶️"
    });

    if (uvIndex >= THRESHOLDS.UV.HIGH) {
      clothingItems.push({
        item: "Sunscreen",
        emoji: "🧴"
      });
      clothingItems.push({
        item: "Hat",
        emoji: "👒"
      });
    }
  }

  if (windSpeed > THRESHOLDS.WIND_CHILL.LIGHT.threshold) {
    clothingItems.push({
      item: "Wind Protection",
      emoji: "💨"
    });
  }

  // Return the complete APL data
  return {
    background: backgroundType,
    timeOfDay: isDaytime ? "day" : "night",
    clothingRecommendations: clothingItems,
    temperature: Math.round(effTemp),
    temperatureCategory: tempCategory,
    weatherCondition: weatherDesc,
    uvIndex: uvIndex,
    humidity: humidity,
    windSpeed: windSpeed
  };
}
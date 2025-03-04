/**
 * @fileoverview
 * AWS Lambda for an Alexa skill that provides weather-based clothing recommendations.
 * - Input: event.zip (ZIP code)
 * - Output: JSON with a spoken response and APL display data for Echo Show devices.
 */

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
      const idx = hourlyTimes.indexOf(currentTime);

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
      const currentTimeObj = new Date(currentTime);
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
              apl: visualData                 // APL data for Echo Show
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

  // Wind chill approximations (user's table)
  if (windMph >= 5 && windMph <= 10) {
      eff -= 4;
  } else if (windMph >= 11 && windMph <= 20) {
      eff -= 8;
  } else if (windMph >= 21 && windMph <= 30) {
      eff -= 12;
  } else if (windMph > 30) {
      eff -= 18;
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
 * - Big category swings (≥ 2 levels different from now)
 * - Notable precipitation (> 0.25)
 * - High wind (> 25 mph) in the next 8 hours
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
  if (!hourlyTimes.length || startIndex < 0) return "";

  const hourlyTemps = weatherData.hourly.temperature_2m || [];
  const hourlyWinds = weatherData.hourly.windspeed_10m || [];
  const hourlyHumids = weatherData.hourly.relativehumidity_2m || [];
  const hourlyPrecips = weatherData.hourly.precipitation || [];
  const hourlyCodes = weatherData.hourly.weathercode || [];

  // Category info for "now"
  const currentCategory = getTempCategory(nowEff);
  const currentCatIndex = categoryIndex(currentCategory);

  const nowDate = new Date(hourlyTimes[startIndex]);
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
      if (t.getDate() !== nowDate.getDate()) break;

      const rawTemp = hourlyTemps[i];
      const wind = hourlyWinds[i];
      const hum = hourlyHumids[i];
      const prec = hourlyPrecips[i];
      const code = hourlyCodes[i];

      const eff = computeEffectiveTemp(rawTemp, wind, hum);
      const cat = getTempCategory(eff);
      const catIdx = categoryIndex(cat);

      // 1) Big temp category swing
      if (!notifiedConditions.tempSwing && Math.abs(catIdx - currentCatIndex) >= 2) {
          statements.push(`Around ${formatHour(t)}, it may feel ${cat}. ${shortAdviceForCategory(cat)}`);
          notifiedConditions.tempSwing = true;
      }

      // 2) Precipitation
      if (!notifiedConditions.precipitation && prec > 0.25) {
          const futureDesc = getWeatherDescription(code).toLowerCase();
          statements.push(`Expect ${futureDesc} near ${formatHour(t)}, so bring rain gear.`);
          notifiedConditions.precipitation = true;
      }

      // 3) High wind
      if (!notifiedConditions.wind && wind > 25 && i <= startIndex + 8) {
          statements.push(`Strong winds expected around ${formatHour(t)}, consider wind protection.`);
          notifiedConditions.wind = true;
      }
  }

  if (!statements.length) {
      return "";
  }

  // Keep it concise by limiting to two statements
  if (statements.length > 2) {
      statements.splice(2);
  }

  return `Later today, watch for changes. ${statements.join(" ")}`;
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
  if (effTemp < 0) return "extreme cold";
  if (effTemp < 20) return "very cold";
  if (effTemp < 35) return "cold";
  if (effTemp < 50) return "cool";
  if (effTemp < 65) return "mild";
  if (effTemp < 80) return "warm";
  if (effTemp < 90) return "hot";
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

  // Precip check
  if (precip > 0.25) {
      advice += " Bring a waterproof layer.";
  } else if (precip > 0) {
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
  if (windSpeed > 10 && effTemp < 50) {
      advice += " A windproof coat helps.";
  }

  // High humidity + warm
  if (humidity > 70 && effTemp > 70) {
      advice += " Moisture-wicking fabric is good in humidity.";
  }

  // UV mention only if it's daytime
  if (isDaytime) {
      if (uvIndex >= 6) {
          advice += " UV is high, wear sunscreen and a hat.";
      } else if (uvIndex >= 3) {
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
  if (precip > 0) {
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

  if (isDaytime && uvIndex >= 3) {
    clothingItems.push({
      item: "Sunglasses",
      emoji: "🕶️"
    });

    if (uvIndex >= 6) {
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

  if (windSpeed > 15) {
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
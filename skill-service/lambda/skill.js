const Alexa = require('ask-sdk-core');
const https = require('https');

const SkillIntentHandler = {
  canHandle(handlerInput) {
    return handlerInput.requestEnvelope.request.type === 'IntentRequest'
      && handlerInput.requestEnvelope.request.intent.name === 'HowManyLayersIntent';
  },
  async handle(handlerInput) {
    const { requestEnvelope, serviceClientFactory, responseBuilder } = handlerInput;
    const consentToken = (requestEnvelope.context.System.user.permissions && requestEnvelope.context.System.user.permissions.consentToken) || null;

    if (!consentToken) {
      return responseBuilder
        .speak("Please enable location permissions in the Alexa app.")
        .withAskForPermissionsConsentCard(["read::alexa:device:all:address:country_and_postal_code"])
        .getResponse();
    }

    try {
      const deviceId = requestEnvelope.context.System.device.deviceId;
      const client = serviceClientFactory.getDeviceAddressServiceClient();
      const address = await client.getCountryAndPostalCode(deviceId);

      if (!address.postalCode) {
        return responseBuilder.speak("I couldn't get your zip code.").getResponse();
      }

      const zipCode = address.postalCode;
      const responseData = await callHowManyLayersAPI(zipCode);
      const spokenMessage = responseData.response || "I'm sorry, something went wrong.";

      // Check if device supports APL - corrected check
      if (requestEnvelope.context.System.device.supportedInterfaces['Alexa.Presentation.APL']) {
        // Log the data for debugging
        console.log('Weather background type:', responseData.apl.background);
        console.log('Full response data:', JSON.stringify(responseData));

        // Create APL document with explicit weather background
        const weatherBackground = responseData.apl.background || 'sunny'; // Default to sunny if undefined

        return responseBuilder
          .speak(spokenMessage)
          .addDirective({
            type: 'Alexa.Presentation.APL.RenderDocument',
            document: getAPLDocument(weatherBackground),
            datasources: {
              weatherData: {
                weatherBackground: weatherBackground,
                timeOfDay: responseData.apl.timeOfDay,
                clothingItems: responseData.apl.clothingRecommendations || [],
                temperature: responseData.temperature || '',
                condition: responseData.weatherDescription || '',
                location: responseData.locationName || zipCode
              }
            }
          })
          .getResponse();
      } else {
        // Device doesn't support screens, just return voice response
        return responseBuilder
          .speak(spokenMessage)
          .getResponse();
      }
    } catch (err) {
      console.error('Error occurred:', err);
      return responseBuilder
        .speak("I'm having trouble reaching the fashion service right now.")
        .getResponse();
    }
  }
};

// Helper function to call your API Gateway endpoint
function callHowManyLayersAPI(zipCode) {
  const url = `https://????.amazonaws.com/AlexaHowManyLayersToday?zip=${zipCode}`;
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', (e) => {
      reject(e);
    });
  });
}

// Function that returns the APL document - simplified and fixed
function getAPLDocument(weatherType) {
  // Fixed color mapping
  const colorMap = {
    sunny: { start: "#4CA1FF", end: "#76CDF3" },
    rainy: { start: "#5C6E91", end: "#39547B" },
    snowy: { start: "#A1C4FD", end: "#C2E9FB" },
    overcast: { start: "#606c88", end: "#3f4c6b" },
    foggy: { start: "#8e9eab", end: "#eef2f3" },
    stormy: { start: "#373B44", end: "#4286f4" },
    night: { start: "#141E30", end: "#243B55" },
    // Default colors as fallback
    default: { start: "#4CA1FF", end: "#76CDF3" }
  };

  // Get appropriate colors, with fallback to default
  const colors = colorMap[weatherType] || colorMap.default;

  // Fixed emoji mapping
  const emojiMap = {
    sunny: '☀️',
    rainy: '🌧️',
    snowy: '❄️',
    overcast: '☁️',
    foggy: '🌫️',
    stormy: '⚡',
    night: '🌙',
    default: '🌤️'
  };

  // Get appropriate emoji with fallback
  const emoji = emojiMap[weatherType] || emojiMap.default;

  return {
    type: 'APL',
    version: '1.8',
    import: [
      {
        name: 'alexa-layouts',
        version: '1.5.0'
      }
    ],
    resources: [
      {
        colors: {
          lightText: "#FFFFFF",
          darkText: "#151920"
        }
      }
    ],
    styles: {
      textStyleBase: {
        description: 'Base text style',
        values: [
          {
            color: "#FFFFFF",
            fontSize: '24dp',
            fontWeight: 400
          }
        ]
      },
      textStyleTitle: {
        description: 'Title text style',
        extend: 'textStyleBase',
        values: {
          fontSize: '38dp',
          fontWeight: 700
        }
      },
      textStyleWeather: {
        description: 'Weather info style',
        extend: 'textStyleBase',
        values: {
          fontSize: '28dp'
        }
      },
      textStyleEmoji: {
        description: 'Emoji style',
        extend: 'textStyleBase',
        values: {
          fontSize: '54dp'
        }
      }
    },
    layouts: {},
    mainTemplate: {
      parameters: [
        'weatherData'
      ],
      items: [
        {
          type: 'Container',
          width: '100%',
          height: '100%',
          items: [
            // Fixed background gradient with explicit colors
            {
              type: 'Frame',
              backgroundColor: colors.start,
              gradientColor: colors.end,
              gradientDirection: "bottom",
              width: '100%',
              height: '100%',
              position: 'absolute'
            },
            {
              type: 'Container',
              width: '100%',
              height: '100%',
              items: [
                // Weather icons container
                {
                  type: 'Container',
                  width: '100%',
                  height: '30%',
                  alignItems: 'center',
                  justifyContent: 'center',
                  items: [
                    {
                      type: 'Text',
                      text: emoji,
                      fontSize: '80dp',
                      paddingTop: '20dp'
                    }
                  ]
                },
                // Location and condition info
                {
                  type: 'Container',
                  direction: 'column',
                  width: '100%',
                  alignItems: 'center',
                  justifyContent: 'center',
                  items: [
                    {
                      type: 'Text',
                      text: "${weatherData.location}",
                      style: 'textStyleTitle'
                    },
                    {
                      type: 'Text',
                      text: "${weatherData.temperature}°F",
                      style: 'textStyleTitle',
                      paddingTop: '10dp'
                    },
                    {
                      type: 'Text',
                      text: "${weatherData.condition}",
                      style: 'textStyleWeather',
                      paddingTop: '5dp'
                    }
                  ]
                },
                // Recommended clothing items with emojis - with null check
                {
                  type: 'Container',
                  width: '100%',
                  height: '45%',
                  paddingLeft: '50dp',
                  paddingRight: '50dp',
                  paddingTop: '30dp',
                  items: [
                    {
                      type: 'Sequence',
                      scrollDirection: 'horizontal',
                      width: '100%',
                      height: '100%',
                      data: "${weatherData.clothingItems}",
                      numbered: false,
                      items: [
                        {
                          type: 'Container',
                          width: '120dp',
                          height: '120dp',
                          margin: '10dp',
                          backgroundColor: 'rgba(255, 255, 255, 0.2)',
                          borderRadius: '60dp',
                          alignItems: 'center',
                          justifyContent: 'center',
                          direction: 'column',
                          items: [
                            {
                              type: 'Text',
                              text: "${data.emoji}",
                              style: 'textStyleEmoji'
                            },
                            {
                              type: 'Text',
                              text: "${data.item}",
                              style: 'textStyleBase',
                              fontSize: '18dp',
                              paddingTop: '5dp'
                            }
                          ]
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
  };
}

module.exports = {
  SkillIntentHandler
};
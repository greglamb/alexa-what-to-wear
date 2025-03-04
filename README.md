# Alexa, What Should I Wear Today Skill

This repository contains an Alexa skill that helps users decide what clothing to wear based on current weather conditions. When a user asks "Alexa, ask what I should wear today" the skill fetches the user's location, retrieves weather data from an external API, and provides clothing recommendations.

> **Created with the assistance of AI tools (ChatGPT and Claude)**

> (So if there's a bug in the code or a lie in the documentation, it wasn't me!)

## Project Architecture

The project consists of two main components:

1. **Alexa Skill Service (Node.js Lambda)** - Handles Alexa skill requests, manages permissions, and renders content
2. **Weather Service (JavaScript Lambda)** - Gets weather data and generates clothing recommendations

### How It Works

1. User asks Alexa about clothing recommendations
2. Alexa skill requests user's zip code (with permission)
3. Skill calls weather service API with the zip code
4. Weather service fetches weather data from Open-Meteo API
5. Weather service generates clothing recommendations
6. Alexa provides verbal response and visual display for Echo Show devices

## Prerequisites

- Amazon Developer Account
- AWS Account
- Node.js and npm installed locally
- Basic knowledge of AWS Lambda and Amazon Alexa Skills

## Setup Instructions

### Part 1: Deploy the Weather Service Lambda

1. **Create a new Lambda function:**
   - Sign in to AWS Console and navigate to Lambda
   - Click "Create function"
   - Choose "Author from scratch"
   - Name: `WeatherLayersService`
   - Runtime: Node.js 18.x
   - Architecture: x86_64
   - Click "Create function"

2. **Upload the weather service code:**
   - Copy the contents of `weather-service/index.mjs` into the Lambda code editor
   - Click "Deploy"

3. **Configure API Gateway:**
   - In the Lambda designer, click "Add trigger"
   - Select "API Gateway"
   - Create a new API:
     - API type: REST API
     - Security: Open (for development - add auth for production)
   - Click "Add"
   - Configure the new API:
     - Method: GET
     - Resource path: `/AlexaHowManyLayersToday`
     - Query parameters: `zip` (required)
   - Note the API endpoint URL that gets generated

### Part 2: Deploy the Alexa Skill Service

1. **Create a new Lambda function:**
   - Navigate to Lambda in AWS Console
   - Click "Create function"
   - Choose "Author from scratch"
   - Name: `AlexaHowManyLayersSkill`
   - Runtime: Node.js 18.x
   - Architecture: x86_64
   - Click "Create function"

2. **Upload the skill service files:**
   - Zip all files from the `skill-service/lambda` directory
   - Upload the zip file using the "Upload from" button in the Lambda designer
   - Note: Make sure to include all dependencies (node_modules) in the zip

3. **Update API Gateway URL:**
   - In the Lambda code editor, open `skill.js`
   - Find the `callHowManyLayersAPI` function
   - Update the URL to match your API Gateway endpoint from Part 1
   - Click "Deploy"

4. **Configure permissions:**
   - Under "Configuration" → "Permissions" add the following policy to the role:
     ```json
     {
         "Version": "2012-10-17",
         "Statement": [
             {
                 "Effect": "Allow",
                 "Action": [
                     "logs:CreateLogGroup",
                     "logs:CreateLogStream",
                     "logs:PutLogEvents"
                 ],
                 "Resource": "arn:aws:logs:*:*:*"
             }
         ]
     }
     ```

5. **Note your Lambda ARN:**
   - Copy the function ARN from the top right of the page (will look like `arn:aws:lambda:region:account-id:function:AlexaHowManyLayersSkill`)

### Part 3: Create the Alexa Skill

1. **Sign in to the Alexa Developer Console:**
   - Go to [developer.amazon.com](https://developer.amazon.com/)
   - Sign in and navigate to the Alexa Skills Console

2. **Create a new skill:**
   - Click "Create Skill"
   - Skill name: "How Many Layers"
   - Default language: English (US)
   - Choose a model: "Custom"
   - Choose a hosting method: "Provision your own"
   - Click "Create skill"

3. **Choose a template:**
   - Select "Start from scratch"
   - Click "Continue with template"

4. **Configure invocation name:**
   - Navigate to "Invocation"
   - Set the skill invocation name to "weather layers"
   - Click "Save Model"

5. **Create intents:**
   - Navigate to "Interaction Model" → "Intents"
   - Keep the default intents and add a new custom intent:
     - Click "Add Intent"
     - Name: "HowManyLayersIntent"
     - Sample utterances (add the following):
       - "what should I wear today"
       - "how many layers do I need"
       - "what clothes should I wear"
       - "do I need a jacket"
       - "what's the weather clothing recommendation"
       - "how should I dress today"
     - Click "Save Model"

6. **Configure permissions:**
   - Navigate to "Tools" → "Permission"
   - Enable "Device Address: Country and Postal Code"

7. **Configure endpoint:**
   - Navigate to "Endpoint"
   - Select "AWS Lambda ARN"
   - Paste the ARN from your Alexa skill Lambda function
   - Click "Save Endpoints"

8. **Configure APL interface:**
   - Navigate to "Interfaces"
   - Enable "Alexa Presentation Language"
   - Click "Save Interfaces"

9. **Build the model:**
   - Click "Build Model"
   - Wait for the build to complete

### Part 4: Test the Skill

1. **Enable testing:**
   - Navigate to "Test" tab
   - Enable testing for the skill
   - Set testing to "Development"

2. **Test with voice or text:**
   - Say or type: "ask weather layers what should I wear today"
   - For the first time, you'll need to grant location permissions in the Alexa app
   - The skill should respond with clothing recommendations based on the weather

## Troubleshooting

### Common Issues:

1. **"Please enable location permissions"**
   - You need to grant the skill access to your device's location in the Alexa app

2. **Lambda execution errors**
   - Check CloudWatch logs for both Lambda functions
   - Verify the API Gateway endpoint is correct in your skill Lambda

3. **"I couldn't get your zip code"**
   - Make sure your Alexa device has a location set in the Alexa app

4. **APL not showing on Echo Show**
   - Verify the APL interface is enabled
   - Check for errors in the APL document structure in the `skill.js` file

## Development Notes

### Skill Service Components

- `index.js`: Main entry point that registers all handlers
- `skill.js`: Contains the custom intent handler for weather recommendations
- `package.json`: Defines dependencies

### Weather Service Components

- `index.mjs`: Handles weather data fetching and recommendation logic

### APL Components

The skill uses Alexa Presentation Language (APL) to create visual displays on Echo Show devices that include:

- Weather background image that changes based on conditions
- Current temperature and weather description
- Visual clothing recommendations with emojis

## Future Improvements

1. Add caching to reduce API calls
2. Implement custom voices with SSML
3. Add persistent user preferences (temperature sensitivity)
4. Support for scheduled notifications

## License

This project is licensed under the Apache License 2.0.

## Acknowledgements

- This project was created with the assistance of AI tools (ChatGPT and Claude)
- Weather data provided by [Open-Meteo API](https://open-meteo.com/)
- Alexa Skills Kit SDK for Node.js
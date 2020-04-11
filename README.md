# self-report backend

Firebase functions for covid-self-report.

## Migrating from v0.0.1
Please follow the migration guide in [MIGRATION.md](https://github.com/ch-covid-19/self-report-backend/blob/master/MIGRATION.md)

## Getting started
1. Create a firebase project if not already done
2. Clone this project
3. Update the `firebase.json` and `.firebaserc` files to reflect your configuration
4. Create a `.runtimeconfig.json` file based on `env.example.json` and update it with your values
5. Run `npm run env` from within the functions directory to populate your environment variables
6. Run `firebase serve` to test locally and `firebase deploy` to deploy it

### Configuration file
You have to manually create a `/functions/.runtimeconfig.json` file and set your backend config in it.
```js
{
  "host": {
    "domain": "", // Currently unused
    "region": "" // Firebase region of hosting
  },
  "recaptcha": {
    "secret": "", // Recaptcha secret value (not public key)
    "verifyurl": "https://recaptcha.google.com/recaptcha/api/siteverify"
  },
  "db": {
    "report": "individual-report",
    "suspicious": "individual-report-suspicious",
    "dev": "individual-report-development",
    "daily_changes": "daily-changes"
  },
  "export": {
    "token": "" // A token you can set to whatever value (we recommand using https://passwordsgenerator.net/ to generate a secure hash) this will be used to secure the export_json function
  }
}
```

## Firebase

### Firestore
After creating your firebase project, navigate to your database section and make sure to enable native firestore. This is required to be able to use the Firestore API from within functions.

### Rules
In order to use and secure your firestore, navigate to the rules tab of the firestore section, and write the following content:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow create: if request.auth.token.admin == true;
      allow read: if request.auth.token.admin == true;
      allow update: if request.auth.token.admin == true;
      allow delete: if request.auth.token.admin == true;
    }
  }
}
```
These rules make sure only admin can perform CRUD operations on your firestore, which is the case when a function is run. This ensures no one except your functions can access your firestore.

### Indexes
Your report collection requires an index to work:
- sessionId: ascending
- timestamp: descending


### Using firebase.json to deploy frontend (optional)
Your `.firebase.json` file contains metadata about the project, including valuable informations if you want to host the frontend on Firebase. For it, you can use this simple configuration:
```json
{
    "hosting": {
        "public": "public",
        "ignore": [
        "firebase.json",
        "**/.*",
        "**/node_modules/**"
        ]
    }
}
```
Please note that the published website **must** be inside the /public directory. As such, you must first build the frontend and copy the dist/ content inside the public directory.

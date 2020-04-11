# Migration guide for daily changes

Currently you should have two or three firestore collections, mainly:
- reports where all reports are stored
- suspicious reports where unvalidated recaptcha reports go
- dev if you've been working on backend and using the dev collection

After the migration there'll be a fourth one, which will include all daily changes for each day and each geolocation. Daily changes will then be used by a custom github action to automatically generate datasets.

## What are daily changes
Daily changes are the slight variations that happen for each geolocation every day per diagnostic.

For example, given a user that reports feeling good at geolocation 1000, the daily change for this day will be of this form:
```
{
    "locator": 1000,
    "daystamp": "2020-04-11",
    "diagnostics": {
        "0": 1
    }
}
```

Now if two days later he reports sicks, the daily change for two days later will be:
```
{
    "locator": 1000,
    "daystamp": "2020-04-11",
    "diagnostics": {
        "0": -1,
        "2": 1
    }
}
```

In order to track evolution across time.

## Migration guide

### Pull latest changes from master branch
First pull changes in your local project.

### Update your `.runtimeconfig.json` file
A new `db.daily_changes` environment variable has to be setup, it's the collection name in which daily changes will live.

You can then run `npm run env` to notify firebase of your new environment variables.

### Creating the firestore index
The new report function requires a specific index on your report collections.
1. Go to your firebase console and go to database
2. Check the name of the collection in which user reports go (the `db.report` environment variable)
3. Go to Indexes -> add new Index
4.  - Collection ID: the collection name of the reports
    - Fields to index, you have to provide two, those are:
        - sessionId: ascending
        - timestamp: descending

This step is very important, firestore won't be able to insert anything if it's not set.

### Deploying the new firebase functions

The backend now comes with the following functions:
- updated `report` to track daily changes as well
- `daily_json` which returns daily changes for a given day (format YEAR-MONTH-DAY, ex. 2020-03-28)
- `build_daily_changes` which will be used in the migration process

You can deploy those new functions with `firebase deploy --only functions`

### Populating the daily changes collection
Daily changes generation depends on previous days data to build current day as illustrated in the upper example. For this we need the daily changes collection
to be up to date. Building daily changes from the beginning can be easily done with one API call.

1. Open your firebase dashboard, go to functions and copy the URL of the `build_daily_changes` one
2. This function takes two arguments, `token` and `collections`.
    - Token is the read token
    - collections is the name of the collection(s) in which your reports are stored. It's possible to provide multiple because, for example, in Switzerland, we started with a first one and currently
    are using a v2 collection.
3. Call the function using your web browser or curl through GET, like the following: `https://xxx.cloudfunctions.net/build_daily_changes?token=YOUR_TOKEN&collections=reports`.
4. **If you have multiple collections** you can separate them with a `,`. For switzerland it was `&collections=individual-report,individual-report-v2`. Put them in order, from the one holding the oldest reports up to the newest ones.

This function will work by batchs of size 500 which is the firestore limit.

### Checking
In order to check you can go to your deployed frontend and try to report your status.
After that, going back to your firebase console and to your firestore collections, a new daily changes collection should have appeared with your diagnostic tracked.

You can also try to call the `daily_json` function (firebase console -> functions to get its URL), it requires the read token as `token` query parameter and should return today's daily changes.

### Deploying the github function
You're now all ready on the backend side, you can now go [setup the github action on your dataset repository](https://github.com/ch-covid-19/data-github-action) to automate their generation!

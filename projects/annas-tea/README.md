# Anna's Tea

Learn how prices, sales and costs affect a small tea shop's profit. Follow a normal day, compare a promotion and change the assumptions yourself.

For beginners, more sales can look like success even when discounts and costs leave less profit. This illustrated lesson connects those numbers through a worked example and an editable experiment.

## What you can do

- **Guided lesson:** follow a normal day, understand revenue versus profit, predict a promotion's effect and compare the result with normal trading.
- **Explore shop:** choose a normal day's cups sold and price, then test a promotion against that reference.
- **Try your own scenario:** change cups sold, selling price before discount, discount percentage and extra staffing cost. Run the day to see how revenue, costs and profit change.
- **See the summary:** compare the daily breakdown with an estimate for 26 identical trading days.

The illustrations provide the shop setting; all explanations, controls and financial results are rendered separately as accessible HTML. This is a beginner learning tool, not accounting software or a demand forecast.

## Run locally

Requires Node.js 22 or later. No dependency installation is needed.

```sh
cd projects/annas-tea
npm start
```

Open http://127.0.0.1:4173 after starting the server. Stop it with Ctrl+C. Run `npm test` in a separate terminal from `projects/annas-tea` to check the calculation model and preview server.
For a different port, set the `PORT` environment variable before starting.
For static hosting, serve this folder with relative asset/module paths; there is no build step or backend API.

The optional monthly estimate uses 26 identical trading days. Changing experiment inputs marks the previous result outdated until another run. No account, analytics, external API, runtime AI or saved business data is used. Refreshing returns to welcome. See [pages.md](pages.md) for screen behavior and model extension points.

The calculation model uses integer cents. Turnout is an input, not a prediction caused by a discount. Profit here means revenue minus the included cup and operating costs; taxes, financing and inventory changes are outside this lesson.

## AI use

AI assisted the implementation, tests and original scene illustrations. Financial assumptions are educational examples, not measured business data or forecasts.

## License

Application code and original scene illustrations: MIT (see LICENSE). Bundled fonts retain their SIL Open Font License files.

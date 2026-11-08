# Service Business Toolkit

Working demos of the tools a home-service business runs on, built on one fictional company (Summit Home Services: HVAC, plumbing and appliance repair). Live at **https://tedkelly.dev/projects/**.

| Step | Demo | What it shows |
|---|---|---|
| 1 | [Work Order Intake](work-order-intake/) | Messy warranty/customer email → clean ticket, suggested tech, first-contact text; optional Claude extraction |
| 2 | [Quote Builder](quote-builder/) | Price-book quotes, Good/Better/Best, owner margin view, customer approve link, print to PDF |
| 3 | [Dispatch Board](dispatch-board/) | Day timeline per tech, drag-and-drop scheduling, first-call deadline alerts |
| 4 | [Owner's Dashboard](kpi-dashboard/) | Revenue per tech, time to first call, callbacks, receivables aging, "needs your attention" |

Plain HTML, CSS and JavaScript: no build step, no backend. Shared fictional data lives in [`shared/data.js`](shared/data.js). Changes made in a demo are saved only in the visitor's browser.

All companies, people, addresses and claim numbers are fictional. Built by [Ted Kelly](https://tedkelly.dev).

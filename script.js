// script.js
const LAT = 39.4143;
const LON = -77.4105;
const STATION_ID = 'KFDK';

async function loadWeatherAndPolicy() {
  const now = new Date();
  const day = now.getDay(); // Sunday=0, Monday=1, ..., Friday=5
  const hour = now.getHours();

  // Monitor all day Sunday, and from 5 PM onward on Mondays and Fridays
  const isSunday = day === 0;
  const isMondayEvening = day === 1 && hour >= 17;
  const isFridayEvening = day === 5 && hour >= 17;
  const monitorAlerts = isSunday || isMondayEvening || isFridayEvening;

  try {
    // 1) Fetch policy and grid‐point metadata
    const [policyRes, pointRes] = await Promise.all([
      fetch('policy.json'),
      fetch(`https://api.weather.gov/points/${LAT},${LON}`)
    ]);
    const policy = await policyRes.json();
    const pointData = await pointRes.json();

    // 2) Build NOAA endpoints
    const forecastURL = pointData.properties.forecast;
    const forecastHourlyURL = pointData.properties.forecastHourly;
    const alertURL = `https://api.weather.gov/alerts/active?point=${LAT},${LON}`;
    const obsURL = `https://api.weather.gov/stations/${STATION_ID}/observations/latest`;

    // 3) Fetch forecast, alerts, current obs, and hourly forecast in parallel
    const [forecastRes, alertRes, obsRes, hourlyRes] = await Promise.all([
      fetch(forecastURL),
      fetch(alertURL),
      fetch(obsURL),
      fetch(forecastHourlyURL)
    ]);
    const forecastData = await forecastRes.json();
    const alertData = await alertRes.json();
    const obsData = await obsRes.json();
    const hourlyData = await hourlyRes.json();

    // 4) Parse current observations
    const obs = obsData.properties;
    const toFahrenheit = c =>
      c !== null && c !== undefined ? (c * 9/5 + 32).toFixed(1) : 'N/A';
    const obsTempF = toFahrenheit(obs.temperature.value);
    const windMps = obs.windSpeed.value;
    const windMph = windMps !== null ? (windMps * 2.237).toFixed(1) : null;
    const humidity = obs.relativeHumidity.value;
    const textDesc = obs.textDescription;
    const timeReported = new Date(obs.timestamp).toLocaleString();

    // 5) Render current conditions
    const conditionsHTML = `
      <p><strong>Current conditions at Frederick Municipal Airport (${STATION_ID}):</strong></p>
      <ul>
        <li>Temperature: ${obsTempF}°F</li>
        <li>Humidity: ${humidity}%</li>
        <li>Wind: ${windMph ? windMph : 'N/A'} mph</li>
        <li>Conditions: ${textDesc}</li>
        <li>Reported: ${timeReported}</li>
      </ul>
    `;
    document.getElementById('conditions').innerHTML = conditionsHTML;

    // 6) Build 10-day daytime forecast
    const forecastPeriods = forecastData.properties.periods;
    const daytimeForecasts = forecastPeriods
      .filter(p => p.isDaytime)
      .slice(0, 10);
    const forecastContainer = document.getElementById('forecast');
    forecastContainer.innerHTML = daytimeForecasts
      .map(
        (period, idx) => `
      <div class="forecast-card" data-index="${idx}">
        <h3>${period.name}</h3>
        <img src="${period.icon}" alt="${period.shortForecast}" />
        <p><strong>${period.temperature}°${period.temperatureUnit}</strong></p>
        <p style="font-size: 0.85rem; margin-top: 0.25rem;">
          ${period.shortForecast}
        </p>
      </div>
    `
      )
      .join('');

    // 7) Pre-calculate precipitation probability for each daytime period
    const hourlyPeriods = hourlyData.properties.periods;
    const precipByPeriod = daytimeForecasts.map(period => {
      const start = new Date(period.startTime);
      const end = new Date(period.endTime);
      let maxProb = 0;
      hourlyPeriods.forEach(h => {
        const hTime = new Date(h.startTime);
        if (hTime >= start && hTime < end) {
          const prob = h.probabilityOfPrecipitation?.value || 0;
          if (prob > maxProb) maxProb = prob;
        }
      });
      return maxProb; // percentage
    });

    // 8) Attach “click any card → expand all” behavior
    document
      .querySelectorAll('.forecast-card')
      .forEach(card =>
        card.addEventListener('click', () => {
          const anyExpanded = document.querySelector('.forecast-details');
          if (anyExpanded) {
            // Collapse all
            document.querySelectorAll('.forecast-details').forEach(d => d.remove());
            return;
          }
          // Expand every card
          document.querySelectorAll('.forecast-card').forEach(allCard => {
            const idx = parseInt(allCard.getAttribute('data-index'), 10);
            const period = daytimeForecasts[idx];
            const details = document.createElement('div');
            details.className = 'forecast-details';
            details.innerHTML = `
              <p><strong>Detailed Forecast:</strong> ${period.detailedForecast}</p>
              <ul>
                <li>High: ${period.temperature}°${period.temperatureUnit}</li>
                <li>Wind: ${period.windSpeed} ${period.windDirection}</li>
                <li>Short Forecast: ${period.shortForecast}</li>
                <li>Precipitation Chance: ${precipByPeriod[idx]}%</li>
              </ul>
            `;
            allCard.appendChild(details);
          });
        })
      );

    // 9) If outside our monitoring window, show placeholder and bail
    const alertBox = document.getElementById('alerts');
    if (!monitorAlerts) {
      alertBox.innerHTML =
        '<p>No weather alerts monitored at this time.</p>';
      animateOnScroll();
      return;
    }

    // 10) Evaluate “current” and “future” policy matches
    const activeAlerts = alertData.features.map(f => f.properties.event);
    const nowMatches = [];
    const futureMatches = [];
    const todayDetailed =
      (forecastPeriods[0] && forecastPeriods[0].detailedForecast) || '';

    for (const rule of policy.rules) {
      let match = false;
      let value = null;
      switch (rule.condition) {
        case 'weather_alert':
          match = activeAlerts.includes(rule.type);
          value = rule.type;
          break;
        case 'snow_accumulation':
          match = /snow/i.test(todayDetailed);
          value = match ? 'Snow mentioned' : null;
          break;
        case 'ice_accumulation':
          match = /ice/i.test(todayDetailed);
          value = match ? 'Ice mentioned' : null;
          break;
        case 'rain_rate':
          match = /rain/i.test(todayDetailed);
          value = match ? 'Rain mentioned' : null;
          break;
        case 'wind_speed':
          if (windMph !== null) {
            value = parseFloat(windMph);
            match = value >= rule.threshold;
          }
          break;
        case 'hail_warning':
          match =
            activeAlerts.includes('Severe Thunderstorm Warning') &&
            /hail/i.test(todayDetailed);
          value = match ? 'Hail risk' : null;
          break;
        case 'visibility':
          match = /fog|blizzard/i.test(todayDetailed);
          value = match ? 'Low visibility' : null;
          break;
        case 'temperature':
          if (obsTempF !== 'N/A') {
            value = parseFloat(obsTempF);
            match =
              rule.comparison === '<='
                ? value <= rule.threshold
                : value >= rule.threshold;
          }
          break;
        case 'heat_index':
          const hiMatch = todayDetailed.match(/High near (\d+)/i);
          if (hiMatch) {
            value = parseInt(hiMatch[1], 10);
            match = value >= rule.threshold;
          }
          break;
        case 'air_quality_index':
          value = 'Unavailable';
          match = false;
          break;
        default:
          match = false;
      }
      if (match) {
        nowMatches.push({
          when: 'Now',
          condition: rule.condition,
          value,
          action: rule.action
        });
      }
    }

    // Future check next 5 daytime periods
    const futureToCheck = daytimeForecasts.slice(1, 6);
    futureToCheck.forEach((period, i) => {
      const desc = period.detailedForecast || '';
      for (const rule of policy.rules) {
        let match = false;
        let value = null;
        switch (rule.condition) {
          case 'weather_alert':
            match = false;
            break;
          case 'snow_accumulation':
            match = /snow/i.test(desc);
            value = match ? 'Snow mentioned' : null;
            break;
          case 'ice_accumulation':
            match = /ice/i.test(desc);
            value = match ? 'Ice mentioned' : null;
            break;
          case 'rain_rate':
            match = /rain/i.test(desc);
            value = match ? 'Rain mentioned' : null;
            break;
          case 'wind_speed':
            match = false;
            break;
          case 'hail_warning':
            match = /hail/i.test(desc);
            value = match ? 'Hail risk' : null;
            break;
          case 'visibility':
            match = /fog|blizzard/i.test(desc);
            value = match ? 'Low visibility' : null;
            break;
          case 'temperature':
            const tMatch = desc.match(/High near (\d+)/i);
            if (tMatch) {
              value = parseInt(tMatch[1], 10);
              match =
                rule.comparison === '<='
                  ? value <= rule.threshold
                  : value >= rule.threshold;
            }
            break;
          case 'heat_index':
            const hiMatchF = desc.match(/High near (\d+)/i);
            if (hiMatchF) {
              value = parseInt(hiMatchF[1], 10);
              match = value >= rule.threshold;
            }
            break;
          case 'air_quality_index':
            value = 'Unavailable';
            match = false;
            break;
          default:
            match = false;
        }
        if (match) {
          futureMatches.push({
            when: period.name,
            condition: rule.condition,
            value,
            action: rule.action
          });
        }
      }
    });

    // 11) Render alerts & predictions
    let combinedHTML = '';
    if (nowMatches.length) {
      combinedHTML += `<p><strong>Current Alert Recommendations:</strong></p>`;
      nowMatches.forEach(r => {
        combinedHTML += `
          <div class="alert">
            <b>${r.condition}</b>: ${r.value} → ${r.action}
          </div>
        `;
      });
    }
    if (futureMatches.length) {
      combinedHTML += `<p style="margin-top:1rem;"><strong>Upcoming Alert Predictions:</strong></p>`;
      futureMatches.forEach(r => {
        combinedHTML += `
          <div class="alert">
            <b>${r.when}</b> – <i>${r.condition}</i>: ${r.value} → ${r.action}
          </div>
        `;
      });
    }
    if (!nowMatches.length && !futureMatches.length) {
      combinedHTML = `<p>No current or upcoming weather concerns at this time.</p>`;
    }
    alertBox.innerHTML = combinedHTML;

    animateOnScroll();
  } catch (err) {
    console.error(err);
    document.getElementById('alerts').innerHTML = `<p>Error loading NOAA data: ${err.message}</p>`;
    document.getElementById('conditions').innerHTML = `<p>Unable to load current conditions.</p>`;
    document.getElementById('forecast').innerHTML = `<p>Unable to load forecast.</p>`;
  }
}

function animateOnScroll() {
  gsap.registerPlugin(ScrollTrigger);

  gsap.utils.toArray('.card').forEach(card => {
    gsap.fromTo(
      card,
      { opacity: 0, y: 30 },
      {
        opacity: 1,
        y: 0,
        duration: 0.8,
        ease: 'power2.out',
        scrollTrigger: {
          trigger: card,
          start: 'top 80%',
          toggleActions: 'play none none none',
        },
      }
    );
  });

  gsap.fromTo(
    '#conditions',
    { opacity: 0, y: 30 },
    {
      opacity: 1,
      y: 0,
      duration: 0.8,
      ease: 'power2.out',
      scrollTrigger: {
        trigger: '#conditions',
        start: 'top 85%',
        toggleActions: 'play none none none',
      },
    }
  );

  gsap.utils.toArray('.forecast-card').forEach(card => {
    gsap.fromTo(
      card,
      { opacity: 0, y: 30 },
      {
        opacity: 1,
        y: 0,
        duration: 0.6,
        ease: 'power2.out',
        scrollTrigger: {
          trigger: card,
          start: 'top 90%',
          toggleActions: 'play none none none',
        },
      }
    );
  });

  gsap.fromTo(
    '#forecast',
    { opacity: 0, y: 30 },
    {
      opacity: 1,
      y: 0,
      duration: 0.8,
      ease: 'power2.out',
      scrollTrigger: {
        trigger: '#forecast',
        start: 'top 80%',
        toggleActions: 'play none none none',
      },
    }
  );

  gsap.fromTo(
    'iframe',
    { opacity: 0, y: 30 },
    {
      opacity: 1,
      y: 0,
      duration: 1,
      ease: 'power2.out',
      scrollTrigger: {
        trigger: 'iframe',
        start: 'top 80%',
        toggleActions: 'play none none none',
      },
    }
  );

  gsap.utils.toArray('h2').forEach(heading => {
    gsap.fromTo(
      heading,
      { opacity: 0, y: 20 },
      {
        opacity: 1,
        y: 0,
        duration: 0.6,
        ease: 'power2.out',
        scrollTrigger: {
          trigger: heading,
          start: 'top 90%',
          toggleActions: 'play none none none',
        },
      }
    );
  });
}

window.addEventListener('load', loadWeatherAndPolicy);

document.getElementById('togglePolicy').addEventListener('click', () => {
  const box = document.getElementById('policyText');
  const btn = document.getElementById('togglePolicy');
  const isHidden = box.hasAttribute('hidden');
  if (isHidden) {
    box.removeAttribute('hidden');
    btn.textContent = 'Hide Policy';
  } else {
    box.setAttribute('hidden', true);
    btn.textContent = 'Show Policy';
  }
  ScrollTrigger.refresh();
});

document.getElementById('toggleSOP').addEventListener('click', () => {
  const box = document.getElementById('sopText');
  const btn = document.getElementById('toggleSOP');
  const isHidden = box.hasAttribute('hidden');
  if (isHidden) {
    box.removeAttribute('hidden');
    btn.textContent = 'Hide SOP';
  } else {
    box.setAttribute('hidden', true);
    btn.textContent = 'Show SOP';
  }
  ScrollTrigger.refresh();
});
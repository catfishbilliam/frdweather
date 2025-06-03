const LAT = 39.4143;
const LON = -77.4105;
const STATION_ID = 'KFDK';

const SLACK_BOT_TOKEN = 'SLACK_BOT_TOKEN…';
const USER_SLACK_ID   = 'U12345678';

const PHRASES = {
  snow: [/\bsnow\b/i, /wintry mix/i, /snowfall of \d+/i],
  rain: [/\brain\b/i, /showers/i, /precipitation/i],
  ice: [/freezing rain/i, /\bice\b/i, /icy conditions/i],
  hail: [/hail/i],
  fog: [/fog/i, /low visibility/i, /dense fog/i],
  heat: [/heat index.*?(\d+)/i, /hot and humid/i]
};

function matchesCondition(desc, type) {
  const checks = PHRASES[type] || [];
  return checks.some(regex => regex.test(desc));
}

function extractHeatIndex(desc) {
  const match = desc.match(/heat index.*?(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

async function sendTestSlackDM() {
  try {
    const resp = await fetch('/.netlify/functions/send-slack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: '🔔 This is a test DM from the FRD Weather page!'
      })
    });
    const data = await resp.json();
    if (resp.ok && data.ok) {
      alert('✅ Slack test DM sent successfully!');
    } else {
      console.error('Function error:', data);
      alert('Error sending Slack DM: ' + (data.error || 'unknown'));
    }
  } catch (e) {
    console.error('Fetch error:', e);
    alert('Failed to call Slack-DM function: ' + e.message);
  }
}

async function loadWeatherAndPolicy() {
  try {
    // 1) Fetch policy.json and NOAA grid-point metadata
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
    const textDesc = obs.textDescription || '';
    const timeReported = new Date(obs.timestamp).toLocaleString();

    // 5) Render current conditions
    const conditionsHTML = `
      <p><strong>Current conditions at Frederick Municipal Airport (${STATION_ID}):</strong></p>
      <ul>
        <li>Temperature: ${obsTempF}°F</li>
        <li>Humidity: ${humidity.toFixed(2)}%</li>
        <li>Wind: ${windMph ? windMph : 'N/A'} mph</li>
        <li>Conditions: ${textDesc}</li>
        <li>Reported: ${timeReported}</li>
      </ul>
    `;
    document.getElementById('conditions').innerHTML = conditionsHTML;

    // 6) Build 5-day daytime forecast
    const forecastPeriods = forecastData.properties.periods;
    const daytimeForecasts = forecastPeriods.filter(p => p.isDaytime).slice(0, 5);
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
      return maxProb; 
    });

    // 8) Attach “click any card → expand all” behavior
    document.querySelectorAll('.forecast-card').forEach(card =>
      card.addEventListener('click', () => {
        const anyExpanded = document.querySelector('.forecast-details');
        if (anyExpanded) {
          document.querySelectorAll('.forecast-details').forEach(d => d.remove());
          return;
        }
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

    // 9) Complex risk analysis for “Now” and “Upcoming”
    const activeAlerts = alertData.features.map(f => f.properties.event);
    const nowMatches = [];
    const futureMatches = [];

    // Determine next practice date/time
    let nextPractice = new Date();
    const weekday = nextPractice.getDay();
    const h = nextPractice.getHours();
    const minute = nextPractice.getMinutes();

    if (weekday === 0 || weekday === 6) {
      const daysUntilMonday = (1 + 7 - weekday) % 7;
      nextPractice.setDate(nextPractice.getDate() + daysUntilMonday);
      nextPractice.setHours(18, 15, 0, 0);
    } else if (weekday === 1) {
      if (h < 18 || (h === 18 && minute < 15)) {
        nextPractice.setHours(18, 15, 0, 0);
      } else {
        const daysUntilFriday = 5 - weekday;
        nextPractice.setDate(nextPractice.getDate() + daysUntilFriday);
        nextPractice.setHours(19, 15, 0, 0);
      }
    } else if (weekday > 1 && weekday < 5) {
      const daysUntilFriday = 5 - weekday;
      nextPractice.setDate(nextPractice.getDate() + daysUntilFriday);
      nextPractice.setHours(19, 15, 0, 0);
    } else if (weekday === 5) {
      if (h < 19 || (h === 19 && minute < 15)) {
        nextPractice.setHours(19, 15, 0, 0);
      } else {
        nextPractice.setDate(nextPractice.getDate() + 3);
        nextPractice.setHours(18, 15, 0, 0);
      }
    }

    // Find which forecast period covers nextPractice
    let practicePeriod = forecastPeriods[0];
    for (let p of forecastPeriods) {
      const start = new Date(p.startTime);
      const end = new Date(p.endTime);
      if (nextPractice >= start && nextPractice < end) {
        practicePeriod = p;
        break;
      }
    }
    const todayDetailed = practicePeriod.detailedForecast || '';

    const formattedPractice = nextPractice.toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
    let practiceHeader = document.getElementById('nextPractice');
    if (!practiceHeader) {
      practiceHeader = document.createElement('div');
      practiceHeader.id = 'nextPractice';
      practiceHeader.style.textAlign = 'center';
      practiceHeader.style.fontWeight = '600';
      practiceHeader.style.marginBottom = '0.75rem';

      const alertsContainer = document.getElementById('alerts');
      if (alertsContainer && alertsContainer.parentNode) {
        alertsContainer.parentNode.insertBefore(practiceHeader, alertsContainer);
      }
    }
    practiceHeader.textContent = `Assessing weather for next practice: ${formattedPractice}`;

    let drivingRiskScore = 0;
    let venueRiskScore = 0;

    function scoreCurrentCondition(rule, desc) {
      switch (rule.condition) {
        case 'weather_alert':
          if (activeAlerts.includes(rule.type)) {
            nowMatches.push({
              when: 'Now',
              condition: rule.condition,
              value: rule.type,
              action: rule.action
            });
            if (
              ['Winter Storm Warning', 'Ice Storm Warning', 'Flood Warning'].includes(
                rule.type
              )
            ) {
              drivingRiskScore += 5;
            }
            if (
              ['Tornado Warning', 'Severe Thunderstorm Warning'].includes(rule.type)
            ) {
              venueRiskScore += 5;
            }
          }
          break;

        case 'snow_accumulation':
          if (matchesCondition(desc, 'snow')) {
            nowMatches.push({
              when: 'Now',
              condition: rule.condition,
              value: 'Snow mentioned',
              action: rule.action
            });
            drivingRiskScore += 4;
          }
          break;

        case 'ice_accumulation':
          if (matchesCondition(desc, 'ice')) {
            nowMatches.push({
              when: 'Now',
              condition: rule.condition,
              value: 'Ice mentioned',
              action: rule.action
            });
            drivingRiskScore += 5;
          }
          break;

        case 'rain_rate':
          if (
            matchesCondition(desc, 'rain') &&
            precipByPeriod[0] >= rule.threshold_pct
          ) {
            nowMatches.push({
              when: 'Now',
              condition: rule.condition,
              value: `${precipByPeriod[0]}%`,
              action: rule.action
            });
            drivingRiskScore += 2;
          }
          break;

        case 'wind_speed':
          if (windMph !== null) {
            const val = parseFloat(windMph);
            if (val >= rule.threshold) {
              nowMatches.push({
                when: 'Now',
                condition: rule.condition,
                value: val,
                action: rule.action
              });
              drivingRiskScore += 2;
              venueRiskScore += 3;
            }
          }
          break;

        case 'hail_warning':
          if (
            activeAlerts.includes('Severe Thunderstorm Warning') &&
            matchesCondition(desc, 'hail')
          ) {
            nowMatches.push({
              when: 'Now',
              condition: rule.condition,
              value: 'Hail risk',
              action: rule.action
            });
            venueRiskScore += 5;
          }
          break;

        case 'visibility':
          if (matchesCondition(desc, 'fog')) {
            nowMatches.push({
              when: 'Now',
              condition: rule.condition,
              value: 'Low visibility',
              action: rule.action
            });
            drivingRiskScore += 4;
          }
          break;

        case 'temperature':
          if (obsTempF !== 'N/A') {
            const val = parseFloat(obsTempF);
            if (
              rule.comparison === '<='
                ? val <= rule.threshold
                : val >= rule.threshold
            ) {
              nowMatches.push({
                when: 'Now',
                condition: rule.condition,
                value: val,
                action: rule.action
              });
              if (rule.comparison === '>=') venueRiskScore += 2;
            }
          }
          break;

        case 'heat_index':
          const hi = extractHeatIndex(desc);
          if (hi !== null && hi >= rule.threshold) {
            nowMatches.push({
              when: 'Now',
              condition: rule.condition,
              value: hi,
              action: rule.action
            });
            venueRiskScore += 3;
          }
          break;

        case 'air_quality_index':
          break;

        default:
          break;
      }
    }

    // Score “Now”
    policy.rules.forEach(rule => {
      scoreCurrentCondition(rule, todayDetailed);
    });

    // Future check next 4 daytime periods
    const futureToCheck = daytimeForecasts.slice(1, 5);
    futureToCheck.forEach((period, idx) => {
      const desc = period.detailedForecast || '';
      policy.rules.forEach(rule => {
        switch (rule.condition) {
          case 'weather_alert':
            break;
          case 'snow_accumulation':
            if (matchesCondition(desc, 'snow')) {
              futureMatches.push({
                when: period.name,
                condition: rule.condition,
                value: 'Snow mentioned',
                action: rule.action
              });
              drivingRiskScore += 4;
            }
            break;
          case 'ice_accumulation':
            if (matchesCondition(desc, 'ice')) {
              futureMatches.push({
                when: period.name,
                condition: rule.condition,
                value: 'Ice mentioned',
                action: rule.action
              });
              drivingRiskScore += 5;
            }
            break;
          case 'rain_rate':
            if (
              matchesCondition(desc, 'rain') &&
              precipByPeriod[idx + 1] >= rule.threshold_pct
            ) {
              futureMatches.push({
                when: period.name,
                condition: rule.condition,
                value: `${precipByPeriod[idx + 1]}%`,
                action: rule.action
              });
              drivingRiskScore += 2;
            }
            break;
          case 'wind_speed':
            break;
          case 'hail_warning':
            if (matchesCondition(desc, 'hail')) {
              futureMatches.push({
                when: period.name,
                condition: rule.condition,
                value: 'Hail risk',
                action: rule.action
              });
              venueRiskScore += 5;
            }
            break;
          case 'visibility':
            if (matchesCondition(desc, 'fog')) {
              futureMatches.push({
                when: period.name,
                condition: rule.condition,
                value: 'Low visibility',
                action: rule.action
              });
              drivingRiskScore += 4;
            }
            break;
          case 'temperature':
            const tMatch = desc.match(/High near (\d+)/i);
            if (tMatch) {
              const val = parseInt(tMatch[1], 10);
              if (
                rule.comparison === '<='
                  ? val <= rule.threshold
                  : val >= rule.threshold
              ) {
                futureMatches.push({
                  when: period.name,
                  condition: rule.condition,
                  value: val,
                  action: rule.action
                });
                if (rule.comparison === '>=') venueRiskScore += 2;
              }
            }
            break;
          case 'heat_index':
            const hiMatchF = desc.match(/High near (\d+)/i);
            if (hiMatchF) {
              const val = parseInt(hiMatchF[1], 10);
              if (val >= rule.threshold) {
                futureMatches.push({
                  when: period.name,
                  condition: rule.condition,
                  value: val,
                  action: rule.action
                });
                venueRiskScore += 3;
              }
            }
            break;
          case 'air_quality_index':
            break;
          default:
            break;
        }
      });
    });

    let drivingRisk = 'Low';
    if (drivingRiskScore >= 5) drivingRisk = 'High';
    else if (drivingRiskScore >= 3) drivingRisk = 'Medium';

    let venueRisk = 'Low';
    if (venueRiskScore >= 5) venueRisk = 'High';
    else if (venueRiskScore >= 3) venueRisk = 'Medium';

    // 10) Render risk summary, alerts & predictions INSIDE Alerts & Recommendations
    const alertBox = document.getElementById('alerts');
    let combinedHTML = `
      <p><strong>Driving Risk Level:</strong> ${drivingRisk}</p>
      <p><strong>Venue Risk Level:</strong> ${venueRisk}</p>
    `;

    if (nowMatches.length) {
      combinedHTML += `<p><strong>Current Alert Recommendations:</strong></p>`;
      nowMatches.forEach(r => {
        combinedHTML += `<div class="alert"><b>${r.condition}</b>: ${r.value} → ${r.action}</div>`;
      });
    }

    if (futureMatches.length) {
      combinedHTML += `<p style="margin-top:1rem;"><strong>Upcoming Alert Predictions:</strong></p>`;
      futureMatches.forEach(r => {
        combinedHTML += `<div class="alert"><b>${r.when}</b> – <i>${r.condition}</i>: ${r.value} → ${r.action}</div>`;
      });
    }

    if (!nowMatches.length && !futureMatches.length) {
      combinedHTML += `<p>No current or upcoming weather concerns at this time.</p>`;
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
          toggleActions: 'play none none none'
        }
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
        toggleActions: 'play none none none'
      }
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
          toggleActions: 'play none none none'
        }
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
        toggleActions: 'play none none none'
      }
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
        toggleActions: 'play none none none'
      }
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
          toggleActions: 'play none none none'
        }
      }
    );
  });
}

window.addEventListener('load', loadWeatherAndPolicy);
document.getElementById('sendTestSlack')?.addEventListener('click', sendTestSlackDM);
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
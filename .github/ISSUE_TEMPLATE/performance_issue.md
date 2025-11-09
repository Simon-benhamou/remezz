---
name: Performance Issue
about: Report performance degradation or resource issues
title: '[PERFORMANCE] '
labels: performance, needs-triage
assignees: ''
---

## Performance Issue Type

- [ ] Slow API response
- [ ] Memory leak
- [ ] High CPU usage
- [ ] Database query performance
- [ ] Network latency
- [ ] UI rendering lag
- [ ] Other: [describe]

## Environment

- **Component**: [Backend / Frontend / Database / Infrastructure]
- **Environment**: [Development / Staging / Production]
- **Version**: [e.g., v3.0.0]
- **Server Specs** (if applicable): [CPU, RAM, etc.]

## Description

A clear description of the performance issue.

## Observed Metrics

- **Response Time**: [e.g., 5 seconds]
- **Expected Time**: [e.g., < 500ms]
- **Memory Usage**: [e.g., 2GB climbing to 8GB]
- **CPU Usage**: [e.g., consistently at 90%]
- **Frequency**: [e.g., happens on every request, or only during peak hours]

## Steps to Reproduce

1. Start the application
2. Perform action '...'
3. Observe performance metrics
4. See degradation

## Screenshots/Metrics

Include profiling data, charts, or screenshots showing the performance issue.

```
[Paste relevant metrics, logs, or profiling output]
```

## Expected Performance

What should the performance be? (e.g., API should respond in < 500ms)

## Actual Performance

What is the actual measured performance? (e.g., API responds in 5 seconds)

## Impact

- [ ] **Critical** - System unusable or severely degraded
- [ ] **High** - Significant user experience impact
- [ ] **Medium** - Noticeable but manageable
- [ ] **Low** - Minor impact, not urgent

## Load Conditions

- **Concurrent Users**: [e.g., 10, 100, 1000]
- **Data Volume**: [e.g., processing 1000 orders]
- **Time of Day**: [e.g., during market hours, off-peak]

## Additional Context

- When did this start happening?
- Has it always been this way, or is it a regression?
- Any recent changes that might have caused this?
- System resource availability (disk space, network bandwidth, etc.)

## Possible Solution

If you have ideas about optimization or the root cause, share them here.

## Related Issues

Link to related issues: #123

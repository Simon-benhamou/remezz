# Predictor Engine Test Suite

This directory contains comprehensive tests for the QuantAILabs prediction engine.

## Test Files

### 1. `test_prediction_engine.py`
Original test suite validating basic prediction functionality.

**Tests**: 3
- Prediction signature validation
- Confidence scaling with signal strength
- Engine object predictions

### 2. `test_predictor_reliability.py`
Comprehensive reliability tests covering edge cases and boundary conditions.

**Tests**: 28
- Extreme value handling (RSI, volatility, momentum)
- Zero and near-zero values
- Missing features
- Cooldown logic
- Probability normalization
- LSTM encoder robustness
- MetaLearner predictions
- Sequential stability
- State persistence
- Market scenarios (bullish, bearish, neutral)

### 3. `test_production_scenarios.py`
Realistic production scenario tests simulating real market conditions.

**Tests**: 12
- Bull/bear trending markets
- Sideways markets
- High volatility conditions
- Flash crash scenarios
- Rapid consecutive predictions
- Market regime transitions
- Entry weight and risk multiplier scaling
- Engine consistency
- Batch processing

## Running Tests

### Run All Tests
```bash
# From backend/python directory
python tests/test_prediction_engine.py
python tests/test_predictor_reliability.py
python tests/test_production_scenarios.py
```

### Run Specific Test Suite
```bash
# Original tests
python tests/test_prediction_engine.py

# Reliability tests
python tests/test_predictor_reliability.py

# Production scenario tests
python tests/test_production_scenarios.py
```

### Run with Verbose Output
```bash
# Reliability tests show detailed output by default
python tests/test_predictor_reliability.py

# Production scenario tests show detailed output by default
python tests/test_production_scenarios.py
```

## Test Results Summary

Total: **43 tests**
- ✅ Passed: 43
- ❌ Failed: 0
- Success Rate: **100%**

## Dependencies

All tests require:
- numpy
- pandas (for engine initialization)
- xgboost
- scikit-learn
- ta

These are listed in `backend/requirements.txt`.

## Test Coverage

The test suite covers:

### ✅ Functionality
- Prediction generation
- Probability calculation
- Confidence scoring
- Risk management (cooldown)
- State persistence

### ✅ Robustness
- Extreme values
- Missing data
- Edge cases
- Numerical stability
- Error handling

### ✅ Production Readiness
- Consistency
- Performance
- Batch processing
- Real market scenarios
- Rapid consecutive calls

## Continuous Testing

It's recommended to run these tests:
- Before deploying to production
- After model retraining
- After code changes to prediction engine
- Periodically as part of monitoring

## Adding New Tests

When adding new tests:
1. Follow existing patterns
2. Use descriptive test names starting with `test_`
3. Add assertions for all expected behaviors
4. Print status messages for clarity
5. Update this README

## Interpreting Results

### All Tests Pass ✅
The prediction engine is working correctly and is production-ready.

### Tests Fail ❌
Investigate failures:
1. Check if model files are present
2. Verify dependencies are installed
3. Review error messages
4. Check for code changes affecting predictions

## Contact

For questions about tests or to report issues:
- Review TEST_SUMMARY.md for detailed findings
- Check prediction_engine.py for implementation details
- Check ccxt_xgboost_module.py for training logic

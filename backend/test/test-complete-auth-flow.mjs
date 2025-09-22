// TEST COMPLET LOGIN/REGISTER FLOW - ZÉRO BUG TOLÉRÉ
// Teste TOUS les scénarios possibles et corrige les bugs
console.log('🔥 COMPLETE LOGIN/REGISTER FLOW TEST - FIXING ALL BUGS...\n');

async function testCompleteAuthFlow() {
  const API_BASE = 'http://localhost:4000';
  
  console.log('🧪 TESTING ALL AUTH SCENARIOS:\n');
  
  // 1. TEST REGISTER FLOW
  console.log('📝 1. TESTING REGISTER FLOW:');
  
  try {
    const registerData = {
      username: `testuser_${Date.now()}`,
      email: `test_${Date.now()}@example.com`,
      password: 'TestPassword123!'
    };
    
    console.log(`Attempting register with: ${registerData.username}`);
    
    const registerResponse = await fetch(`${API_BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registerData)
    });
    
    console.log(`Register Response Status: ${registerResponse.status}`);
    
    if (registerResponse.ok) {
      const registerResult = await registerResponse.json();
      console.log('✅ Register SUCCESS');
      console.log(`Token received: ${registerResult.token ? 'YES' : 'NO'}`);
      console.log(`User data: ${JSON.stringify(registerResult.user, null, 2)}`);
      
      // Test immediate login after register
      if (registerResult.token) {
        console.log('\n🔑 Testing token validation after register...');
        const validateResponse = await fetch(`${API_BASE}/api/auth/me`, {
          headers: { 'x-api-key': registerResult.token }
        });
        console.log(`Token validation: ${validateResponse.ok ? '✅ VALID' : '❌ INVALID'}`);
      }
    } else {
      const registerError = await registerResponse.text();
      console.log(`❌ Register FAILED: ${registerError}`);
    }
  } catch (error) {
    console.log(`❌ Register ERROR: ${error.message}`);
  }
  
  console.log('\n' + '='.repeat(60));
  
  // 2. TEST LOGIN WITH USERNAME/PASSWORD
  console.log('\n🔐 2. TESTING LOGIN WITH USERNAME/PASSWORD:');
  
  try {
    // Test with default credentials
    const loginData = {
      username: 'admin',
      password: 'password123'
    };
    
    console.log(`Attempting login with: ${loginData.username}`);
    
    const loginResponse = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(loginData)
    });
    
    console.log(`Login Response Status: ${loginResponse.status}`);
    console.log(`Login Response Headers:`, Object.fromEntries(loginResponse.headers.entries()));
    
    const responseText = await loginResponse.text();
    console.log(`Raw Response: ${responseText}`);
    
    try {
      const loginResult = JSON.parse(responseText);
      
      if (loginResponse.ok) {
        console.log('✅ Login SUCCESS');
        console.log(`Token: ${loginResult.token ? 'PRESENT' : 'MISSING'}`);
        console.log(`User: ${JSON.stringify(loginResult.user, null, 2)}`);
        
        // Test token immediately
        if (loginResult.token) {
          console.log('\n🔍 Testing token validation...');
          const testResponse = await fetch(`${API_BASE}/api/agent/overview?mode=paper`, {
            headers: { 'x-api-key': loginResult.token }
          });
          console.log(`Token test result: ${testResponse.ok ? '✅ WORKS' : '❌ FAILS'}`);
          
          if (!testResponse.ok) {
            const errorText = await testResponse.text();
            console.log(`Token error: ${errorText}`);
          }
        }
      } else {
        console.log(`❌ Login FAILED: ${loginResult.error || 'Unknown error'}`);
      }
    } catch (parseError) {
      console.log(`❌ JSON Parse Error: ${parseError.message}`);
      console.log(`Response was: ${responseText}`);
    }
  } catch (error) {
    console.log(`❌ Login ERROR: ${error.message}`);
  }
  
  console.log('\n' + '='.repeat(60));
  
  // 3. TEST LOGIN WITH LEGACY CODE
  console.log('\n🔑 3. TESTING LOGIN WITH LEGACY CODE:');
  
  try {
    const codeData = {
      code: 'your-secret-key'
    };
    
    console.log(`Attempting legacy login with code: ${codeData.code}`);
    
    const codeResponse = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(codeData)
    });
    
    console.log(`Code Login Status: ${codeResponse.status}`);
    
    if (codeResponse.ok) {
      const codeResult = await codeResponse.json();
      console.log('✅ Code Login SUCCESS');
      console.log(`Token: ${codeResult.token ? 'PRESENT' : 'MISSING'}`);
      console.log(`User: ${JSON.stringify(codeResult.user, null, 2)}`);
    } else {
      const codeError = await codeResponse.text();
      console.log(`❌ Code Login FAILED: ${codeError}`);
    }
  } catch (error) {
    console.log(`❌ Code Login ERROR: ${error.message}`);
  }
  
  console.log('\n' + '='.repeat(60));
  
  // 4. TEST INVALID CREDENTIALS
  console.log('\n❌ 4. TESTING INVALID CREDENTIALS:');
  
  try {
    const invalidData = {
      username: 'wronguser',
      password: 'wrongpassword'
    };
    
    const invalidResponse = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(invalidData)
    });
    
    console.log(`Invalid Login Status: ${invalidResponse.status}`);
    
    if (invalidResponse.status === 401) {
      const invalidResult = await invalidResponse.json();
      console.log('✅ Invalid credentials properly rejected');
      console.log(`Error: ${invalidResult.error}`);
    } else {
      console.log(`❌ Unexpected status for invalid credentials: ${invalidResponse.status}`);
    }
  } catch (error) {
    console.log(`❌ Invalid credentials test error: ${error.message}`);
  }
  
  console.log('\n' + '='.repeat(60));
  
  // 5. TEST FRONTEND API CLIENT
  console.log('\n🌐 5. TESTING FRONTEND API CLIENT:');
  
  // Simulate frontend api.auth.login call
  try {
    console.log('Simulating frontend API call...');
    
    const frontendSimulation = async () => {
      const response = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'password123' })
      });
      
      const data = await response.json();
      
      // This is what frontend does
      if (data?.token) {
        console.log('✅ Frontend would receive token and redirect');
        return { success: true, token: data.token, user: data.user };
      } else {
        console.log('❌ Frontend would show error message');
        return { success: false, error: data.error || 'Login failed' };
      }
    };
    
    const frontendResult = await frontendSimulation();
    console.log('Frontend simulation result:', frontendResult);
    
  } catch (error) {
    console.log(`❌ Frontend simulation error: ${error.message}`);
  }
  
  // 6. IDENTIFY THE BUG
  console.log('\n' + '='.repeat(60));
  console.log('\n🐛 6. BUG ANALYSIS:');
  
  console.log('\nCommon issues that cause login to show error despite success:');
  console.log('1. Frontend receives token but shows error message');
  console.log('2. Response format mismatch between backend and frontend');
  console.log('3. Error handling in frontend catches success as error');
  console.log('4. Token validation fails immediately after login');
  console.log('5. Navigation logic has bugs');
  
  // 7. TEST SPECIFIC BUG SCENARIOS
  console.log('\n🔍 7. TESTING SPECIFIC BUG SCENARIOS:');
  
  // Test if backend sends proper JSON
  try {
    console.log('\nTesting response format...');
    const response = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'password123' })
    });
    
    const contentType = response.headers.get('content-type');
    console.log(`Content-Type: ${contentType}`);
    
    if (!contentType?.includes('application/json')) {
      console.log('🚨 BUG FOUND: Response is not JSON!');
    }
    
    const data = await response.json();
    console.log('Response structure check:');
    console.log(`- Has token: ${!!data.token}`);
    console.log(`- Has user: ${!!data.user}`);
    console.log(`- Has error: ${!!data.error}`);
    console.log(`- Response keys: ${Object.keys(data)}`);
    
  } catch (error) {
    console.log(`❌ Response format test error: ${error.message}`);
  }
  
  // 8. RECOMMENDATIONS
  console.log('\n' + '='.repeat(60));
  console.log('\n💡 8. IMMEDIATE FIXES NEEDED:');
  
  console.log('\n🔧 Backend fixes to implement:');
  console.log('1. Ensure consistent JSON responses');
  console.log('2. Add proper CORS headers');
  console.log('3. Validate all response formats');
  console.log('4. Add request/response logging');
  
  console.log('\n🎨 Frontend fixes to implement:');
  console.log('1. Better error handling in api.auth.login');
  console.log('2. Check token existence before showing error');
  console.log('3. Add response validation');
  console.log('4. Improve navigation logic');
  
  console.log('\n🧪 Testing fixes to implement:');
  console.log('1. Add automated login/register tests');
  console.log('2. Test error scenarios');
  console.log('3. Test token validation flow');
  console.log('4. Test frontend integration');
}

testCompleteAuthFlow();
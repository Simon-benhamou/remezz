import React from 'react';
import { Card, Input, Button, Space, Typography, message } from 'antd';
import { api, getApiKey, setApiKey } from '../api';
import { useNavigate } from 'react-router-dom';

export default function LoginPage(){
  const [code, setCode] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const nav = useNavigate();

  React.useEffect(()=>{ if (getApiKey()) nav('/start', { replace: true }); }, []);

  const submit = async () => {
    setLoading(true);
    try {
      // backend accepts either { username,password } or { code }; we use code-only here
      const out = (await api.client.post('/api/auth/login', { username:"simon", code })).data;
      if (out?.token) setApiKey(out.token);
      message.success('Logged in');
      nav('/start', { replace: true });
    } catch (e:any) {
      message.error('Invalid credentials');
    } finally { setLoading(false); }
  };

  return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center' }}>
      <Card title="Login" style={{ width: 360 }}>
        <Space direction='vertical' style={{ width:'100%' }}>
          <Typography.Paragraph type='secondary'>Enter your access code to continue.</Typography.Paragraph>
          <Input.Password placeholder='Access code' value={code} onChange={e=> setCode(e.target.value)} />
          <Button type='primary' block loading={loading} onClick={submit}>Login</Button>
        </Space>
      </Card>
    </div>
  );
}

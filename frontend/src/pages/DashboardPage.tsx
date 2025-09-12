import React from 'react';
import { Card, Row, Col, Statistic, Space, Button } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

export default function DashboardPage(){
  const [ov, setOv] = React.useState<any>({});
  const [loading, setLoading] = React.useState<boolean>(false);
  const navigate = useNavigate();
  const load = async ()=>{
    try { setLoading(true); setOv(await api.overview()); } finally { setLoading(false); }
  };
  React.useEffect(()=>{ load(); }, []);
  return (
    <Space direction='vertical' style={{ width:'100%' }}>
      <Row gutter={[12,12]}>
        <Col xs={24} md={6}><Card loading={loading}><Statistic title='Active agents' value={ov?.activeCount || 0} /></Card></Col>
        <Col xs={24} md={6}><Card loading={loading}><Statistic title='Total sessions' value={ov?.sessionsCount || 0} /></Card></Col>
        <Col xs={24} md={6}><Card loading={loading}><Statistic title='Avg ROI %' precision={2} value={Number(ov?.avgRoiPct||0)} /></Card></Col>
        <Col xs={24} md={6}><Card loading={loading}><Statistic title='Avg Win Rate %' precision={2} value={Number(ov?.avgWinRate||0)} /></Card></Col>
      </Row>
      <Card>
        <Space>
          <Button type='primary' onClick={()=> navigate('/sessions')}>Go to Sessions</Button>
          <Button onClick={()=> navigate('/monitor')}>Open Monitor</Button>
        </Space>
      </Card>
    </Space>
  );
}


import React from 'react';
import { Card, Table, Button, Space, Tag, Form, Input, Select, message, Modal, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { api } from '../api';

const { TextArea } = Input;
const { Text } = Typography;

const severityColors: Record<string, string> = {
  low: 'default',
  medium: 'blue',
  high: 'orange',
  critical: 'red',
};

const statusColors: Record<string, string> = {
  open: 'red',
  in_progress: 'gold',
  resolved: 'green',
};

export default function BacklogPage(){
  const [items, setItems] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [filterStatus, setFilterStatus] = React.useState<string|undefined>();
  const [form] = Form.useForm();

  const load = React.useCallback(async (status?: string)=>{
    setLoading(true);
    try {
      const data = await api.listImprovements(status);
      setItems(data || []);
    } catch {
      message.error('Failed to load backlog');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(()=>{ load(filterStatus); }, [filterStatus, load]);

  const createItem = async () => {
    try {
      const values = await form.validateFields();
      let contextObj: any = undefined;
      if (values.context) {
        try {
          contextObj = JSON.parse(values.context);
        } catch {
          message.error('Context must be valid JSON');
          return;
        }
      }
      const payload: any = {
        title: values.title,
        description: values.description,
        severity: values.severity || 'medium',
        tags: values.tags || [],
        reporter: values.reporter,
      };
      if (contextObj !== undefined) payload.context = contextObj;
      await api.createImprovement(payload);
      message.success('Improvement logged');
      form.resetFields();
      await load(filterStatus);
    } catch (e: any) {
      if (e?.errorFields) return; // validation handled inline
      message.error('Unable to save improvement');
    }
  };

  const updateStatus = async (id: string, status: string) => {
    try {
      await api.updateImprovement(id, { status });
      await load(filterStatus);
    } catch {
      message.error('Failed to update status');
    }
  };

  const deleteItem = (id: string) => {
    Modal.confirm({
      title: 'Delete improvement?',
      content: 'This will remove the entry from the backlog.',
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.deleteImprovement(id);
          await load(filterStatus);
        } catch {
          message.error('Delete failed');
        }
      },
    });
  };

  const columns: ColumnsType<any> = [
    {
      title: 'Title',
      dataIndex: 'title',
      key: 'title',
      render: (text: string, record: any) => (
        <Space direction='vertical' size={0}>
          <Text strong>{text}</Text>
          <Text type='secondary' style={{ maxWidth: 460 }}>{record.description}</Text>
          {record.context && (
            <Tooltip title={JSON.stringify(record.context, null, 2)}>
              <Tag color='purple'>context</Tag>
            </Tooltip>
          )}
          {(record.tags || []).map((tag: string)=> (<Tag key={tag}>{tag}</Tag>))}
        </Space>
      ),
    },
    {
      title: 'Severity',
      dataIndex: 'severity',
      key: 'severity',
      render: (sev: string) => <Tag color={severityColors[sev] || 'default'} style={{ textTransform:'capitalize' }}>{sev}</Tag>,
      filters: [
        { text: 'Critical', value: 'critical' },
        { text: 'High', value: 'high' },
        { text: 'Medium', value: 'medium' },
        { text: 'Low', value: 'low' },
      ],
      onFilter: (value, record) => record.severity === value,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (_status: string, record: any) => (
        <Select
          size='small'
          value={record.status}
          style={{ width: 150 }}
          onChange={(val)=> updateStatus(record.id, val)}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'in_progress', label: 'In progress' },
            { value: 'resolved', label: 'Resolved' },
          ]}
        />
      ),
    },
    {
      title: 'Reporter',
      dataIndex: 'reporter',
      key: 'reporter',
      render: (t: string) => t || '—',
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (ts: string) => new Date(ts).toLocaleString(),
    },
    {
      title: '',
      key: 'actions',
      render: (_: any, record: any) => (
        <Button danger size='small' onClick={()=> deleteItem(record.id)}>Delete</Button>
      ),
    },
  ];

  return (
    <Space direction='vertical' style={{ width: '100%' }} size='large'>
      <Card title='Log improvement opportunity'>
        <Form layout='vertical' form={form} initialValues={{ severity: 'medium', tags: [] }}>
          <Form.Item label='Title' name='title' rules={[{ required:true, message:'Please add a title' }]}>
            <Input placeholder='Short summary (e.g. Halt should auto-exit position) '/>
          </Form.Item>
          <Form.Item label='Description' name='description' rules={[{ required:true, message:'Describe the behaviour' }]}>
            <TextArea rows={3} placeholder='What happened, expected behaviour, impact, reproduction steps…' />
          </Form.Item>
          <Form.Item label='Severity' name='severity'>
            <Select
              options={[
                { value: 'low', label: 'Low' },
                { value: 'medium', label: 'Medium' },
                { value: 'high', label: 'High' },
                { value: 'critical', label: 'Critical' },
              ]}
            />
          </Form.Item>
          <Form.Item label='Tags' name='tags' tooltip='Optional labels to group similar issues'>
            <Select mode='tags' placeholder='Execution, Risk, UX…' />
          </Form.Item>
          <Form.Item label='Reporter' name='reporter'>
            <Input placeholder='Your name or initials' />
          </Form.Item>
          <Form.Item label='Context (JSON)' name='context' tooltip='Optional structured payload (e.g. sessionId, alert, symbols).'>
            <TextArea rows={2} placeholder='{"sessionId":"...","alert":"capacity_breach"}' />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button type='primary' onClick={createItem}>Add</Button>
              <Button onClick={()=> form.resetFields()}>Clear</Button>
            </Space>
          </Form.Item>
        </Form>
      </Card>

      <Card title='Improvement backlog'
        extra={
          <Select
            allowClear
            placeholder='Filter by status'
            style={{ width: 180 }}
            value={filterStatus}
            onChange={(val)=> setFilterStatus((val as string) || undefined)}
            options={[
              { value: 'open', label: 'Open' },
              { value: 'in_progress', label: 'In progress' },
              { value: 'resolved', label: 'Resolved' },
            ]}
          />
        }
      >
        <Table
          rowKey='id'
          columns={columns}
          dataSource={items}
          loading={loading}
          pagination={{ pageSize: 8 }}
        />
      </Card>
    </Space>
  );
}

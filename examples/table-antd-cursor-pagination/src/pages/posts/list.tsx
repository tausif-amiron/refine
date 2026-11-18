import { List, useTable } from "@refinedev/antd";
import { Table } from "antd";

interface IPost {
  id: number;
  title: string;
  status: string;
}

export const PostList: React.FC = () => {
  const { tableProps } = useTable<IPost>({
    pagination: {
      mode: "cursor",
      pageSize: 5,
    },
  });

  return (
    <List title="Posts (cursor pagination)">
      <Table {...tableProps} rowKey="id">
        <Table.Column dataIndex="id" title="ID" />
        <Table.Column dataIndex="title" title="Title" />
        <Table.Column dataIndex="status" title="Status" />
      </Table>
    </List>
  );
};

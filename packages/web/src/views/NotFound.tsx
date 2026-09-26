import { Link } from '../router';
import './pages.css';

export function NotFound() {
  return (
    <div className="page">
      <h1 className="page-title">Nothing here</h1>
      <p className="page-sub">
        This address is not a page of Verifier Workbench. <Link to="/new">Start a new run</Link>.
      </p>
    </div>
  );
}
